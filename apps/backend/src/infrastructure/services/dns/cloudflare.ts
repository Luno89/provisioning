import { CLOUDFLARE_DNS, DnsProviderRefusal, type DnsCredentials, type DnsProvider, type DnsRecord, type DnsRecordType, type DnsValidation, type DnsZone } from '../../lib/dns-providers.js';
import type { FetchLike } from '../OvhClient.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

interface CfAnswer<T> { success?: boolean; errors?: { message?: string; error_chain?: { message?: string }[] }[]; result: T; result_info?: { page?: number; total_pages?: number } }
interface CfRecord { id: string; type: DnsRecordType; name: string; content: string }

const tokenOf = (credentials: DnsCredentials): string => {
  const token = credentials.token?.trim();
  if (!token) throw new DnsProviderRefusal('A Cloudflare API token is required.');
  if (/\s/.test(token)) throw new DnsProviderRefusal('The Cloudflare token contains a space or line break; it looks like more than the token was pasted.');
  return token;
};

export function cloudflareProvider(fetchImpl: FetchLike = fetch): DnsProvider {
  const call = async <T>(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: CfAnswer<T> }> => {
    const answer = await fetchImpl(`${CLOUDFLARE_API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    return { status: answer.status, body: await answer.json() as CfAnswer<T> };
  };
  const refusal = (path: string, status: number, body: CfAnswer<unknown>): DnsProviderRefusal => {
    const detail = body.errors?.[0]?.error_chain?.[0]?.message ?? body.errors?.map((error) => error.message).filter(Boolean).join('; ') ?? '';
    const hint = /Authorization header/i.test(detail) ? ' Use a scoped API token (Zone → DNS → Edit), not the Global API Key.' : '';
    return new DnsProviderRefusal(`Cloudflare refused ${path.split('?')[0]}: ${detail || `HTTP ${status}`}.${hint}`);
  };
  const result = async <T>(token: string, path: string, init: RequestInit = {}): Promise<T> => {
    const { status, body } = await call<T>(token, path, init);
    if (!body.success) throw refusal(path, status, body);
    return body.result;
  };

  return {
    ...CLOUDFLARE_DNS,
    async validate(credentials: DnsCredentials): Promise<DnsValidation> {
      let token: string;
      try { token = tokenOf(credentials); } catch (error) { return { valid: false, message: (error as Error).message }; }
      const { status, body } = await call<{ name?: string }[]>(token, '/zones');
      if (!body.success) return { valid: false, message: refusal('/zones', status, body).message };
      const zones = (body.result ?? []).map((zone) => zone.name).filter((name): name is string => Boolean(name));
      if (zones.length === 0) return { valid: false, message: 'The token authenticates but can see no zones; scope it to the zones Koala manages.' };
      const wanted = credentials.zone?.trim();
      if (wanted && !zones.includes(wanted)) return { valid: false, message: `The token is valid but cannot see ${wanted}. It can see: ${zones.slice(0, 5).join(', ')}.` };
      return { valid: true, message: `The token can edit ${zones.length} zone${zones.length === 1 ? '' : 's'}: ${zones.slice(0, 5).join(', ')}${zones.length > 5 ? ', …' : ''}.` };
    },
    async zone(credentials: DnsCredentials, zone: string): Promise<DnsZone> {
      const token = tokenOf(credentials);
      const found = (await result<{ id: string; name: string }[]>(token, `/zones?name=${encodeURIComponent(zone)}`)).find((entry) => entry.name === zone);
      if (!found) throw new DnsProviderRefusal(`The Cloudflare token cannot see the zone ${zone}; give it Zone → DNS → Edit on ${zone}.`);
      const records = `/zones/${found.id}/dns_records`;
      const asRecord = (entry: CfRecord): DnsRecord => ({ id: entry.id, type: entry.type, name: entry.name, content: entry.content });
      const body = (record: DnsRecord) => JSON.stringify({ type: record.type, name: record.name, content: record.content, ttl: 1, ...(record.type === 'TXT' ? {} : { proxied: false }) });
      return {
        name: zone,
        all: async () => {
          const found: DnsRecord[] = [];
          for (let page = 1; ; page += 1) {
            const { status, body: answer } = await call<CfRecord[]>(token, `${records}?per_page=500&page=${page}`);
            if (!answer.success) throw refusal(records, status, answer);
            found.push(...answer.result.map(asRecord));
            if (!answer.result_info?.total_pages || page >= answer.result_info.total_pages) return found;
          }
        },
        list: async (type, name) => (await result<CfRecord[]>(token, `${records}?type=${type}&name=${encodeURIComponent(name)}`)).map(asRecord),
        create: async (record) => { await result(token, records, { method: 'POST', body: body(record) }); },
        update: async (record) => { await result(token, `${records}/${record.id}`, { method: 'PUT', body: body(record) }); },
        remove: async (record) => { await result(token, `${records}/${record.id}`, { method: 'DELETE' }); },
      };
    },
  };
}
