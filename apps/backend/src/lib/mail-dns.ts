export interface DnsRecord {
  id?: string | undefined;
  type: 'A' | 'TXT';
  name: string;
  content: string;
}

export type DnsAction =
  | { do: 'create'; record: DnsRecord; why: string }
  | { do: 'update'; record: DnsRecord & { id: string }; why: string }
  | { do: 'keep'; record: DnsRecord; why: string }
  | { do: 'tell'; why: string };

export interface MailDnsWanted {
  domain: string;
  ip: string;
  selector: string;
  dkim: string;
}

export function dkimValue(opendkimTxt: string): string {
  const parts = [...opendkimTxt.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');
  const value = parts.join('').replace(/\s+/g, ' ').trim();
  if (!/^v=DKIM1;/.test(value) || !/p=[A-Za-z0-9+/=]+/.test(value)) throw new Error('that is not an OpenDKIM key record');
  return value;
}

const unquote = (content: string): string => content.replace(/^"|"$/g, '').replace(/" "/g, '');

export const mailHost = (domain: string): string => `mail.${domain}`;

export function mailDnsActions(wanted: MailDnsWanted, existing: readonly DnsRecord[]): DnsAction[] {
  const actions: DnsAction[] = [];
  const at = (type: DnsRecord['type'], name: string) => existing.filter((record) => record.type === type && record.name === name);

  const host = mailHost(wanted.domain);
  const a = at('A', host)[0];
  if (!a) actions.push({ do: 'create', record: { type: 'A', name: host, content: wanted.ip }, why: `${host} points at this host, so its reverse DNS can be checked forwards` });
  else if (a.content === wanted.ip) actions.push({ do: 'keep', record: a, why: `${host} already points here` });
  else actions.push({ do: 'tell', why: `${host} points at ${a.content}, not ${wanted.ip}; it was left as it is. Point it here, or mail from this host will fail its checks` });

  const spf = at('TXT', wanted.domain).find((record) => unquote(record.content).startsWith('v=spf1'));
  const ours = `ip4:${wanted.ip}`;
  if (!spf) actions.push({ do: 'create', record: { type: 'TXT', name: wanted.domain, content: `v=spf1 ${ours} ~all` }, why: 'SPF says this host may send for the domain' });
  else if (unquote(spf.content).split(/\s+/).includes(ours)) actions.push({ do: 'keep', record: spf, why: 'SPF already lets this host send' });
  else actions.push({ do: 'tell', why: `the domain has an SPF record of its own (${unquote(spf.content)}); it was left as it is. Add ${ours} to it, before its all` });

  const dkimName = `${wanted.selector}._domainkey.${wanted.domain}`;
  const dkim = at('TXT', dkimName)[0];
  if (!dkim) actions.push({ do: 'create', record: { type: 'TXT', name: dkimName, content: wanted.dkim }, why: 'DKIM lets receivers check the signature on every message' });
  else if (unquote(dkim.content) === wanted.dkim) actions.push({ do: 'keep', record: dkim, why: 'DKIM already has this host\'s key' });
  else actions.push({ do: 'update', record: { ...dkim, id: dkim.id ?? '', content: wanted.dkim }, why: 'DKIM had another key under Koala\'s selector; it now has this host\'s' });

  const dmarcName = `_dmarc.${wanted.domain}`;
  const dmarc = at('TXT', dmarcName).find((record) => unquote(record.content).startsWith('v=DMARC1'));
  if (!dmarc) actions.push({ do: 'create', record: { type: 'TXT', name: dmarcName, content: 'v=DMARC1; p=none' }, why: 'a DMARC record, which large mailbox providers expect, set to report only' });
  else actions.push({ do: 'keep', record: dmarc, why: 'the domain already has a DMARC policy' });

  actions.push({ do: 'tell', why: `set the reverse DNS (PTR) of ${wanted.ip} to ${host} in your hosting provider's panel; it cannot be set from here, and without it many providers refuse the mail` });
  return actions;
}
