import { readFileSync } from 'node:fs';
import { dkimValue, mailDnsActions, mailHost, type DnsRecord } from '../../apps/backend/src/platform/lib/mail-dns.js';

const [domain, ip, selector = 'koala'] = process.argv.slice(2);
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!domain || !ip || !token) {
  console.error('usage: CLOUDFLARE_API_TOKEN=… tsx mail-dns.ts <domain> <public ip> [selector] < <opendkim txt file>');
  process.exit(2);
}

interface CfRecord { id: string; type: 'A' | 'TXT'; name: string; content: string }

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const body = await response.json() as { success: boolean; errors?: unknown; result: T };
  if (!body.success) throw new Error(`Cloudflare refused ${path}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

async function main(): Promise<void> {
  const dkim = dkimValue(readFileSync(0, 'utf8'));
  const zones = await cf<Array<{ id: string; name: string }>>(`/zones?name=${encodeURIComponent(domain!)}`);
  const zone = zones[0];
  if (!zone) throw new Error(`Cloudflare has no zone ${domain} for this token`);
  const wanted: Array<[DnsRecord['type'], string]> = [['A', mailHost(domain!)], ['TXT', domain!], ['TXT', `${selector}._domainkey.${domain}`], ['TXT', `_dmarc.${domain}`]];
  const existing: DnsRecord[] = (await Promise.all(wanted.map(([type, name]) => cf<CfRecord[]>(`/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}`))))
    .flat().map((record) => ({ id: record.id, type: record.type, name: record.name, content: record.content }));

  let toldSomething = false;
  for (const action of mailDnsActions({ domain: domain!, ip: ip!, selector, dkim }, existing)) {
    if (action.do === 'create') {
      await cf(`/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify({ ...action.record, ttl: 1, ...(action.record.type === 'A' ? { proxied: false } : {}) }) });
      console.log(`  ✓ added ${action.record.type} ${action.record.name}: ${action.why}`);
    } else if (action.do === 'update') {
      await cf(`/zones/${zone.id}/dns_records/${action.record.id}`, { method: 'PUT', body: JSON.stringify({ type: action.record.type, name: action.record.name, content: action.record.content, ttl: 1 }) });
      console.log(`  ✓ updated ${action.record.type} ${action.record.name}: ${action.why}`);
    } else if (action.do === 'keep') {
      console.log(`  ✓ ${action.why}`);
    } else {
      toldSomething = true;
      console.log(`  ! ${action.why}`);
    }
  }
  if (toldSomething) console.log('  The lines marked ! are yours to do; mail is sent either way, but may land in spam until they are.');
}

main().catch((err: Error) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
