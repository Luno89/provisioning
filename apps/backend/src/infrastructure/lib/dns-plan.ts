import type { DnsRecord, DnsRecordType } from './dns-providers.js';

export interface WantedRecord {
  type: DnsRecordType;
  name: string;
  content: string;
  why: string;
  candidate?: ((record: DnsRecord) => boolean) | undefined;
  satisfied?: ((record: DnsRecord) => boolean) | undefined;
  onConflict: 'refuse' | 'replace';
  refused?: ((found: readonly DnsRecord[]) => string) | undefined;
  kept?: string | undefined;
  replaced?: string | undefined;
}

export type PlanStep =
  | { do: 'create'; record: DnsRecord; why: string }
  | { do: 'update'; record: DnsRecord & { id: string }; why: string }
  | { do: 'keep'; record: DnsRecord; why: string }
  | { do: 'refuse'; record: DnsRecord; why: string };

export const unquoted = (content: string): string => content.replace(/^"|"$/g, '').replace(/" "/g, '');

const sameName = (a: string, b: string): boolean => a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '');

export function zonePlan(wanted: readonly WantedRecord[], existing: readonly DnsRecord[]): PlanStep[] {
  return wanted.map((want) => {
    const record: DnsRecord = { type: want.type, name: want.name, content: want.content };
    const here = existing.filter((entry) => entry.type === want.type && sameName(entry.name, want.name) && (want.candidate ?? (() => true))(entry));
    if (here.length === 0) return { do: 'create', record, why: want.why };
    const satisfied = want.satisfied ?? ((entry: DnsRecord) => unquoted(entry.content) === want.content);
    const good = here.find(satisfied);
    if (good) return { do: 'keep', record: good, why: want.kept ?? `${want.type} ${want.name} already says what Koala wants` };
    const first = here[0]!;
    if (want.onConflict === 'replace' && first.id) return { do: 'update', record: { ...first, id: first.id, content: want.content }, why: want.replaced ?? want.why };
    return {
      do: 'refuse',
      record,
      why: want.refused?.(here) ?? `${want.name} already has ${want.type} ${here.map((entry) => unquoted(entry.content)).join(', ')}; Koala does not change a record it did not make. Set it to ${want.content} or delete it, and Koala carries on.`,
    };
  });
}

export const planIsDone = (steps: readonly PlanStep[]): boolean => steps.every((step) => step.do !== 'refuse');
