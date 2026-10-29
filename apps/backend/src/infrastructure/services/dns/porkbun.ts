import { DnsProviderRefusal, PORKBUN_ACCESS, PORKBUN_DNS, type DnsCredentials, type DnsProvider, type DnsRecord, type DnsRecordType, type DnsValidation, type DnsZone } from '../../lib/dns-providers.js';
import type { FetchLike } from '../OvhClient.js';

export const PORKBUN_API = 'https://api.porkbun.com/api/json/v3';

export const PORKBUN_MIN_TTL = '600';

interface PbAnswer { status?: string; message?: string; records?: PbRecord[]; yourIp?: string }
interface PbRecord { id: string; name: string; type: string; content: string }

const keysOf = (credentials: DnsCredentials): { apikey: string; secretapikey: string } => {
  const apikey = credentials.apiKey?.trim();
  const secretapikey = credentials.secretApiKey?.trim();
  if (!apikey || !secretapikey) throw new DnsProviderRefusal('Porkbun needs both its API key and its secret API key.');
  return { apikey, secretapikey };
};

export const subdomainIn = (name: string, zone: string): string => {
  const lower = name.toLowerCase().replace(/\.$/, '');
  const apex = zone.toLowerCase();
  if (lower === apex) return '';
  if (!lower.endsWith(`.${apex}`)) throw new DnsProviderRefusal(`${name} is not in the zone ${zone}`);
  return lower.slice(0, -(apex.length + 1));
};

export function porkbunProvider(fetchImpl: FetchLike = fetch): DnsProvider {
  const call = async (path: string, body: Record<string, string>): Promise<PbAnswer> => {
    const answer = await fetchImpl(`${PORKBUN_API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const parsed = await answer.json().catch(() => ({})) as PbAnswer;
    if (parsed.status !== 'SUCCESS') {
      const said = parsed.message || `HTTP ${answer.status}`;
      const access = /opted in|api access/i.test(said) ? ` ${PORKBUN_ACCESS}` : '';
      throw new DnsProviderRefusal(`Porkbun refused ${path.split('/').slice(0, 3).join('/')}: ${said}.${access}`);
    }
    return parsed;
  };

  return {
    ...PORKBUN_DNS,
    async validate(credentials: DnsCredentials): Promise<DnsValidation> {
      try {
        const answer = await call('/ping', keysOf(credentials));
        return { valid: true, message: `Porkbun accepts these keys${answer.yourIp ? ` (from ${answer.yourIp})` : ''}. ${PORKBUN_ACCESS}` };
      } catch (error) {
        return { valid: false, message: (error as Error).message };
      }
    },
    async zone(credentials: DnsCredentials, zone: string): Promise<DnsZone> {
      const keys = keysOf(credentials);
      await call(`/dns/retrieve/${zone}`, keys);
      const asRecord = (entry: PbRecord): DnsRecord => ({ id: entry.id, type: entry.type as DnsRecordType, name: entry.name, content: entry.content });
      return {
        name: zone,
        all: async () => ((await call(`/dns/retrieve/${zone}`, keys)).records ?? []).map(asRecord),
        list: async (type, name) => {
          const all = (await call(`/dns/retrieve/${zone}`, keys)).records ?? [];
          const wanted = name.toLowerCase().replace(/\.$/, '');
          return all.filter((entry) => entry.type === type && entry.name.toLowerCase() === wanted).map(asRecord);
        },
        create: async (record) => {
          await call(`/dns/create/${zone}`, { ...keys, name: subdomainIn(record.name, zone), type: record.type, content: record.content, ttl: PORKBUN_MIN_TTL });
        },
        update: async (record) => {
          await call(`/dns/edit/${zone}/${record.id}`, { ...keys, name: subdomainIn(record.name, zone), type: record.type, content: record.content, ttl: PORKBUN_MIN_TTL });
        },
        remove: async (record) => {
          await call(`/dns/delete/${zone}/${record.id}`, keys);
        },
      };
    },
  };
}
