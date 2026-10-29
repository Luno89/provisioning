import type { DnsRecord } from '../../lib/dns-providers.js';
import type { FetchLike } from '../OvhClient.js';

export interface FakeZone {
  name: string;
  records: (DnsRecord & { id: string })[];
  reachable: boolean;
}

export interface FakeDns {
  fetch: FetchLike;
  zones: Map<string, FakeZone>;
  calls: string[];
  good: Record<string, string>;
  bad: Record<string, string>;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const zonesOf = (names: readonly string[], reachable: readonly string[]): Map<string, FakeZone> =>
  new Map(names.map((name) => [name, { name, records: [], reachable: reachable.includes(name) }]));

let nextId = 1;
const newId = (): string => `r${nextId++}`;

export function fakeCloudflare(names: readonly string[], reachable: readonly string[] = names): FakeDns {
  const zones = zonesOf(names, reachable);
  const calls: string[] = [];
  const token = 'cf-good-token';
  const zoneIdOf = (name: string) => `zone-${name}`;
  const byId = (id: string) => [...zones.values()].find((zone) => zoneIdOf(zone.name) === id);
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url.pathname}${url.search}`);
    if ((init.headers as Record<string, string> | undefined)?.authorization !== `Bearer ${token}`) return json({ success: false, errors: [{ message: 'Invalid request headers' }], result: null }, 403);
    const path = url.pathname.replace('/client/v4', '');
    if (path === '/zones' && method === 'GET') {
      const asked = url.searchParams.get('name');
      return json({ success: true, result: [...zones.values()].filter((zone) => zone.reachable && (!asked || zone.name === asked)).map((zone) => ({ id: zoneIdOf(zone.name), name: zone.name })) });
    }
    const match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
    const zone = match ? byId(match[1]!) : undefined;
    if (!match || !zone?.reachable) return json({ success: false, errors: [{ message: 'Could not route to this zone' }], result: null }, 404);
    const body = init.body ? JSON.parse(String(init.body)) as DnsRecord : undefined;
    if (method === 'GET') {
      const type = url.searchParams.get('type');
      const name = url.searchParams.get('name');
      const page = Number(url.searchParams.get('page') ?? '1');
      const found = zone.records.filter((record) => (!type || record.type === type) && (!name || record.name === name));
      return json({ success: true, result: name || type ? found : found.slice((page - 1) * 2, page * 2), result_info: { page, total_pages: name || type ? 1 : Math.max(1, Math.ceil(found.length / 2)) } });
    }
    if (method === 'POST' && body) {
      const record = { id: newId(), type: body.type, name: body.name, content: body.content };
      zone.records.push(record);
      return json({ success: true, result: record });
    }
    const at = zone.records.findIndex((record) => record.id === match[2]);
    if (at < 0) return json({ success: false, errors: [{ message: 'Record not found' }], result: null }, 404);
    if (method === 'PUT' && body) {
      zone.records[at] = { id: match[2]!, type: body.type, name: body.name, content: body.content };
      return json({ success: true, result: zone.records[at] });
    }
    if (method === 'DELETE') {
      zone.records.splice(at, 1);
      return json({ success: true, result: { id: match[2] } });
    }
    return json({ success: false, errors: [{ message: `no ${method} here` }], result: null }, 405);
  };
  return { fetch: fetchImpl, zones, calls, good: { token }, bad: { token: 'cf-bad-token' } };
}

export function fakePorkbun(names: readonly string[], reachable: readonly string[] = names): FakeDns {
  const zones = zonesOf(names, reachable);
  const calls: string[] = [];
  const keys = { apikey: 'pk1_good', secretapikey: 'sk1_good' };
  const fqdn = (sub: string, zone: string) => (sub ? `${sub}.${zone}` : zone);
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace('/api/json/v3', '');
    calls.push(`POST ${path}`);
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, string>;
    if (body.apikey !== keys.apikey || body.secretapikey !== keys.secretapikey) return json({ status: 'ERROR', message: 'Invalid API key. (002)' }, 400);
    if (path === '/ping') return json({ status: 'SUCCESS', yourIp: '203.0.113.9' });
    const match = /^\/dns\/(retrieve|create|edit|delete)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const zone = match ? zones.get(match[2]!) : undefined;
    if (!match || !zone) return json({ status: 'ERROR', message: 'Invalid domain.' }, 400);
    if (!zone.reachable) return json({ status: 'ERROR', message: 'Domain is not opted in to API access.' }, 400);
    const [, action, , id] = match;
    if (action === 'retrieve') return json({ status: 'SUCCESS', records: zone.records.map((record) => ({ ...record, ttl: '600', prio: '0', notes: '' })) });
    if (action === 'create') {
      const record = { id: newId(), type: body.type as DnsRecord['type'], name: fqdn(body.name ?? '', zone.name), content: body.content! };
      zone.records.push(record);
      return json({ status: 'SUCCESS', id: Number(record.id.slice(1)) });
    }
    const at = zone.records.findIndex((record) => record.id === id);
    if (at < 0) return json({ status: 'ERROR', message: 'Record not found.' }, 400);
    if (action === 'edit') {
      zone.records[at] = { id: id!, type: body.type as DnsRecord['type'], name: fqdn(body.name ?? '', zone.name), content: body.content! };
      return json({ status: 'SUCCESS' });
    }
    zone.records.splice(at, 1);
    return json({ status: 'SUCCESS' });
  };
  return { fetch: fetchImpl, zones, calls, good: { apiKey: keys.apikey, secretApiKey: keys.secretapikey }, bad: { apiKey: 'pk1_bad', secretApiKey: 'sk1_bad' } };
}

export const FAKE_DNS: Record<string, (names: readonly string[], reachable?: readonly string[]) => FakeDns> = { cloudflare: fakeCloudflare, porkbun: fakePorkbun };
