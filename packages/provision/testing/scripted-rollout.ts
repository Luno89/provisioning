import type { ClusterWatch, Watch } from '../src/informer.js';

interface Scripted { kind?: string; metadata?: { name?: string } }
export interface Snapshot { items: readonly unknown[] }

export interface ScriptedRollout extends ClusterWatch {
  listed: string[];
}

const KIND_OF_PLURAL: Readonly<Record<string, string>> = {
  deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', replicasets: 'ReplicaSet', jobs: 'Job', pods: 'Pod',
};

const kindOf = (path: string): string => {
  const plural = path.split('?')[0]!.split('/').at(-1) ?? '';
  const kind = KIND_OF_PLURAL[plural];
  if (!kind) throw new Error(`the scripted rollout answers only workload kinds, not ${path}`);
  return kind;
};

const keyOf = (item: Scripted): string => `${item.kind}/${item.metadata?.name}`;
const ofKind = (snapshot: Snapshot, kind: string): Scripted[] => (snapshot.items as Scripted[]).filter((item) => item.kind === kind);

interface Open { kind: string; heard: (chunk: string) => void; stopped: boolean }

export function scriptedRollout(rounds: readonly (readonly Snapshot[])[]): ScriptedRollout {
  if (rounds.length === 0 || rounds.some((round) => round.length === 0)) throw new Error('each round of a scripted rollout starts with what is listed');
  const lists = new Map<string, number>();
  const listedIn = new Map<number, Set<string>>();
  const openIn = new Map<number, Open[]>();
  const roundOf = (at: number): readonly Snapshot[] => rounds[at] ?? [rounds.at(-1)!.at(-1)!];
  const count = (counts: Map<string, number>, kind: string): number => {
    const at = counts.get(kind) ?? 0;
    counts.set(kind, at + 1);
    return at;
  };
  const push = (at: number): void => {
    const open = openIn.get(at) ?? [];
    const round = roundOf(at);
    for (let step = 1; step < round.length; step += 1) {
      const before = round[step - 1]!;
      const after = round[step]!;
      for (const watch of open) {
        if (watch.stopped) continue;
        const was = new Map(ofKind(before, watch.kind).map((item) => [keyOf(item), JSON.stringify(item)]));
        const now = ofKind(after, watch.kind);
        for (const item of now) {
          const seen = was.get(keyOf(item));
          if (seen !== JSON.stringify(item)) watch.heard(`${JSON.stringify({ type: seen === undefined ? 'ADDED' : 'MODIFIED', object: item })}\n`);
        }
        const kept = new Set(now.map(keyOf));
        for (const item of ofKind(before, watch.kind)) if (!kept.has(keyOf(item))) watch.heard(`${JSON.stringify({ type: 'DELETED', object: item })}\n`);
      }
    }
  };
  const listed: string[] = [];
  return {
    listed,
    kubectl: async (args) => {
      const path = args[0] === 'get' && args[1]?.startsWith('--raw=') ? args[1].slice('--raw='.length) : undefined;
      if (!path) throw new Error(`the scripted rollout answers only raw lists, not kubectl ${args.join(' ')}`);
      listed.push(path);
      const kind = kindOf(path);
      const at = count(lists, kind);
      listedIn.set(at, (listedIn.get(at) ?? new Set()).add(kind));
      return JSON.stringify({ metadata: { resourceVersion: '1' }, items: ofKind(roundOf(at)[0]!, kind) });
    },
    watch: async (path, heard): Promise<Watch> => {
      const kind = kindOf(path);
      const at = (lists.get(kind) ?? 0) - 1;
      const open: Open = { kind, heard, stopped: false };
      const all = [...(openIn.get(at) ?? []), open];
      openIn.set(at, all);
      let ended: (end: { code: number; stderr: string }) => void = () => undefined;
      const promised = new Promise<{ code: number; stderr: string }>((resolve) => { ended = resolve; });
      if (all.length === listedIn.get(at)?.size) queueMicrotask(() => push(at));
      return { stop: () => { open.stopped = true; ended({ code: -1, stderr: '' }); }, ended: promised };
    },
  };
}
