import type { DnsRecord } from './dns-providers.js';
import { unquoted, zonePlan, type PlanStep, type WantedRecord } from './dns-plan.js';

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

export const mailHost = (domain: string): string => `mail.${domain}`;

export function mailRecords(wanted: MailDnsWanted): WantedRecord[] {
  const host = mailHost(wanted.domain);
  const ours = `ip4:${wanted.ip}`;
  return [
    {
      type: 'A', name: host, content: wanted.ip, onConflict: 'refuse',
      why: `${host} points at this host, so its reverse DNS can be checked forwards`,
      kept: `${host} already points here`,
      refused: (found) => `${host} points at ${found.map((record) => record.content).join(', ')}, not ${wanted.ip}; it was left as it is. Point it here, or mail from this host will fail its checks`,
    },
    {
      type: 'TXT', name: wanted.domain, content: `v=spf1 ${ours} ~all`, onConflict: 'refuse',
      why: 'SPF says this host may send for the domain',
      candidate: (record) => unquoted(record.content).startsWith('v=spf1'),
      satisfied: (record) => unquoted(record.content).split(/\s+/).includes(ours),
      kept: 'SPF already lets this host send',
      refused: (found) => `the domain has an SPF record of its own (${unquoted(found[0]!.content)}); it was left as it is. Add ${ours} to it, before its all`,
    },
    {
      type: 'TXT', name: `${wanted.selector}._domainkey.${wanted.domain}`, content: wanted.dkim, onConflict: 'replace',
      why: 'DKIM lets receivers check the signature on every message',
      kept: 'DKIM already has this host\'s key',
      replaced: 'DKIM had another key under Koala\'s selector; it now has this host\'s',
    },
    {
      type: 'TXT', name: `_dmarc.${wanted.domain}`, content: 'v=DMARC1; p=none', onConflict: 'refuse',
      why: 'a DMARC record, which large mailbox providers expect, set to report only',
      candidate: (record) => unquoted(record.content).startsWith('v=DMARC1'),
      satisfied: () => true,
      kept: 'the domain already has a DMARC policy',
    },
  ];
}

export const mailByHand = (wanted: Pick<MailDnsWanted, 'domain' | 'ip'>): string[] =>
  [`set the reverse DNS (PTR) of ${wanted.ip} to ${mailHost(wanted.domain)} in your hosting provider's panel; it cannot be set from here, and without it many providers refuse the mail`];

export function mailDnsPlan(wanted: MailDnsWanted, existing: readonly DnsRecord[]): { steps: PlanStep[]; byHand: string[] } {
  return { steps: zonePlan(mailRecords(wanted), existing), byHand: mailByHand(wanted) };
}
