import { createHmac } from 'node:crypto';
import type { SourceClass } from './tool-access.js';

import { KIND_TITLES, SIGNAL_KINDS, type SignalKind, type SignalSeverity, type SignalState } from './signal-kinds.js';

export { KIND_TITLES, SIGNAL_KINDS, type SignalKind, type SignalSeverity, type SignalState };

export const SEVERITY_OF: Readonly<Record<SignalKind, SignalSeverity>> = {
  canary: 'certain',
  'private-out': 'high',
  'memory-from-outside': 'medium',
  'unvouched-host': 'low',
  'hidden-in-repo': 'low',
};

const RANK: Readonly<Record<SignalSeverity, number>> = { certain: 0, high: 1, medium: 2, low: 3 };

export const worstFirst = <T extends { severity: SignalSeverity; at: string }>(signals: readonly T[]): T[] =>
  [...signals].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.at.localeCompare(a.at));

export const serious = (severity: SignalSeverity): boolean => severity === 'certain' || severity === 'high';

export const PRIVATE_CLASSES: readonly SourceClass[] = ['logs', 'cluster', 'file', 'repo', 'private'];
export const OUTSIDE_CLASSES: readonly SourceClass[] = ['web', 'mcp', 'agent', 'logs', 'file'];
export const HOST_NAMING_CLASSES: readonly SourceClass[] = ['logs', 'file', 'mcp'];

export const WINDOW_CHARS = 24;
export const STORED_STRIDE = 8;
export const MATCHED_CHARS = WINDOW_CHARS + STORED_STRIDE - 1;

const normalized = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

const decoded = (text: string): string => {
  const spaced = text.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
};

const fingerprint = (key: string, window: string): string => createHmac('sha256', key).update(window).digest('hex').slice(0, 16);

export function fingerprintsOf(key: string, text: string, stride = STORED_STRIDE): string[] {
  const plain = normalized(text);
  const found = new Set<string>();
  for (let at = 0; at + WINDOW_CHARS <= plain.length; at += stride) found.add(fingerprint(key, plain.slice(at, at + WINDOW_CHARS)));
  return [...found];
}

export function sharedSpan(key: string, sent: string, read: ReadonlySet<string>): string | undefined {
  if (read.size === 0) return undefined;
  const plain = normalized(decoded(sent));
  let start = -1;
  let end = -1;
  for (let at = 0; at + WINDOW_CHARS <= plain.length; at += 1) {
    if (!read.has(fingerprint(key, plain.slice(at, at + WINDOW_CHARS)))) continue;
    if (start < 0) start = at;
    end = Math.max(end, at + WINDOW_CHARS);
  }
  return start < 0 ? undefined : plain.slice(start, end);
}

export const writtenByThePerson = (span: string, personText: string): boolean => normalized(decoded(personText)).includes(span);

const URL_IN_TEXT = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;

export const hostsIn = (text: string): string[] => [...new Set([...text.matchAll(URL_IN_TEXT)].map((found) => found[1]!.toLowerCase()))];

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '') || undefined;
  } catch {
    return undefined;
  }
}

const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
};

const OUTBOUND_URL_TOOLS = new Set(['fetch_web_page', 'start_ingest']);

export function outboundOf(tool: string, args: Readonly<Record<string, unknown>>, mcp: boolean): { texts: string[]; host?: string | undefined } | undefined {
  if (OUTBOUND_URL_TOOLS.has(tool)) {
    const url = typeof args.url === 'string' ? args.url : undefined;
    return url ? { texts: [url], host: hostOf(url) } : undefined;
  }
  if (mcp) {
    const texts = stringsIn(args);
    return texts.length ? { texts } : undefined;
  }
  return undefined;
}

const REMEMBERING_TOOLS = new Set(['save_memory', 'propose_practice', 'propose_tool_note']);

export const rememberedOf = (tool: string, args: Readonly<Record<string, unknown>>): string[] =>
  REMEMBERING_TOOLS.has(tool) ? ['title', 'text', 'why'].flatMap((name) => (typeof args[name] === 'string' ? [args[name] as string] : [])) : [];

export const carriesCanary = (rawArguments: string, canary: string): boolean => rawArguments.includes(canary);

export interface ReadsPart {
  classes: SourceClass[];
  private: string[];
  outside: string[];
  hosts: string[];
  readRuns?: string[] | undefined;
}

export const runReadBy = (tool: string, args: Readonly<Record<string, unknown>>): string | undefined =>
  tool === 'read_run' && typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : undefined;

export function readsOf(key: string, source: SourceClass, text: string): ReadsPart {
  if (source === 'none' || !text) return { classes: [], private: [], outside: [], hosts: [] };
  return {
    classes: [source],
    private: PRIVATE_CLASSES.includes(source) ? fingerprintsOf(key, text) : [],
    outside: OUTSIDE_CLASSES.includes(source) ? fingerprintsOf(key, text) : [],
    hosts: HOST_NAMING_CLASSES.includes(source) ? hostsIn(text) : [],
  };
}

export interface CallFinding {
  kind: SignalKind;
  said: string;
  matched?: string | undefined;
  host?: string | undefined;
  path?: string | undefined;
}

export interface CallReads {
  key: string;
  private: ReadonlySet<string>;
  outside: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
  classes: ReadonlySet<SourceClass>;
}

export interface ReadElsewhere {
  key: string;
  outside: ReadonlySet<string>;
  classes: ReadonlySet<SourceClass>;
}

const fromWhich = (classes: ReadonlySet<SourceClass>, among: readonly SourceClass[]): string => {
  const named = among.filter((one) => classes.has(one));
  return named.length ? named.join(', ') : 'what it read';
};

export function findingsOf(call: {
  tool: string;
  rawArguments: string;
  args: Readonly<Record<string, unknown>>;
  mcp: boolean;
  canary: string;
  reads: CallReads;
  elsewhere?: readonly ReadElsewhere[] | undefined;
  personText: string;
}): CallFinding[] {
  const found: CallFinding[] = [];
  if (carriesCanary(call.rawArguments, call.canary)) {
    found.push({ kind: 'canary', said: `${call.tool} was given this run's canary, a value that exists only in what the run was told, so something made the model copy its own context out` });
  }
  const outbound = outboundOf(call.tool, call.args, call.mcp);
  if (outbound) {
    for (const text of outbound.texts) {
      const span = sharedSpan(call.reads.key, text, call.reads.private);
      if (span && !writtenByThePerson(span, call.personText)) {
        found.push({ kind: 'private-out', said: `${call.tool} sent out ${span.length} characters this run read from ${fromWhich(call.reads.classes, PRIVATE_CLASSES)}${outbound.host ? `, to ${outbound.host}` : ''}`, matched: span, ...(outbound.host ? { host: outbound.host } : {}) });
        break;
      }
    }
    if (outbound.host && call.reads.hosts.has(outbound.host) && !hostsIn(call.personText).includes(outbound.host)) {
      found.push({ kind: 'unvouched-host', said: `${call.tool} went to ${outbound.host}, a host only ${fromWhich(call.reads.classes, HOST_NAMING_CLASSES)} named, never the person`, host: outbound.host });
    }
  }
  const remembered = rememberedOf(call.tool, call.args);
  if (remembered.length) {
    const pools = [{ key: call.reads.key, outside: call.reads.outside, classes: call.reads.classes }, ...(call.elsewhere ?? [])];
    outer: for (const text of remembered) {
      for (const pool of pools) {
        const span = sharedSpan(pool.key, text, pool.outside);
        if (span && !writtenByThePerson(span, call.personText)) {
          found.push({ kind: 'memory-from-outside', said: `${call.tool} keeps ${span.length} characters taken from ${fromWhich(pool.classes, OUTSIDE_CLASSES)}`, matched: span });
          break outer;
        }
      }
    }
  }
  return found;
}

export const hiddenInRepo = (tool: string, source: SourceClass, removed: number, args: Readonly<Record<string, unknown>>): CallFinding | undefined => {
  if (source !== 'repo' || removed === 0) return undefined;
  const path = typeof args.path === 'string' ? args.path : undefined;
  return { kind: 'hidden-in-repo', said: `${tool} read ${removed} hidden characters${path ? ` in ${path}` : ''}, which were removed before the model saw them`, ...(path ? { path } : {}) };
};

export const READS_KEPT_DAYS = 30;
export const PRINTS_KEPT = 150_000;

export interface RunReads {
  key: string;
  ownerId: string;
  fpKey: string;
  runs: string[];
  classes: SourceClass[];
  private: string[];
  outside: string[];
  hosts: string[];
  readRuns?: string[] | undefined;
  lastReadAt: string;
}

export interface PoisoningSignal {
  id: string;
  ownerId: string;
  kind: SignalKind;
  severity: SignalSeverity;
  state: SignalState;
  at: string;
  readsKey: string;
  runId: string;
  agentSlug?: string | undefined;
  tool: string;
  said: string;
  sealedMatch?: string | undefined;
  host?: string | undefined;
  path?: string | undefined;
  conversationId?: string | undefined;
  projectId?: string | undefined;
  toldAt?: string | undefined;
  dismissedBecause?: string | undefined;
}

export const signalId = (readsKey: string, finding: Pick<CallFinding, 'kind' | 'host' | 'path'>, tool: string): string =>
  createHmac('sha256', 'koala-signal').update([readsKey, finding.kind, tool, finding.host ?? '', finding.path ?? ''].join('\u0000')).digest('hex').slice(0, 24);

export function sourcesFrom(own: RunReads | undefined, read: readonly RunReads[]): { classes: string[]; hosts: string[]; runs: string[] } | undefined {
  if (!own) return undefined;
  const all = [own, ...read];
  const classes = [...new Set(all.flatMap((reads) => reads.classes))].filter((one) => one !== 'none').sort();
  return {
    classes,
    hosts: [...new Set(all.flatMap((reads) => reads.hosts))].sort(),
    runs: [...new Set([...own.runs, ...(own.readRuns ?? [])])].sort(),
  };
}

export interface SignalView {
  id: string;
  kind: SignalKind;
  severity: SignalSeverity;
  state: SignalState;
  at: string;
  runId: string;
  agentSlug?: string | undefined;
  tool: string;
  said: string;
  matched?: string | undefined;
  host?: string | undefined;
  path?: string | undefined;
  conversationId?: string | undefined;
  projectId?: string | undefined;
  dismissedBecause?: string | undefined;
}

export type RetireScope = 'run' | 'source';

export const retireScopeFrom = (value: unknown): RetireScope | undefined => (value === 'run' || value === 'source' ? value : undefined);

export function tellingOf(signal: Pick<PoisoningSignal, 'kind' | 'said' | 'runId' | 'conversationId'>): { subject: string; text: string; path: string } {
  const path = signal.conversationId ? `/chat/${signal.conversationId}` : `/infrastructure`;
  return {
    subject: `Koala: ${KIND_TITLES[signal.kind]}`,
    text: `${signal.said}.\n\nRun ${signal.runId}. Look under Infrastructure, Needs attention, to see what it left and retire it, or dismiss it.`,
    path,
  };
}

export const memoryFromRun = (memory: { provenance?: { experimentId?: string | undefined } | undefined }, runs: ReadonlySet<string>): boolean =>
  Boolean(memory.provenance?.experimentId && runs.has(memory.provenance.experimentId));

export const memoryFromHost = (memory: { provenance?: { sources?: { hosts?: readonly string[] } | undefined } | undefined }, host: string): boolean =>
  (memory.provenance?.sources?.hosts ?? []).includes(host);
