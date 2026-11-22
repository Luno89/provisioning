export interface OpenWork {
  workflowId: string;
  type: string;
  startedAt: string;
  memo?: Readonly<Record<string, unknown>> | undefined;
}

export type WorkStopState = 'stopping' | 'stopped' | 'restarting' | 'restarted' | 'gone' | 'waiting-machine' | 'machine-removed';

export interface StoppingWork extends OpenWork {
  state: WorkStopState;
  what?: string | undefined;
  worker?: string | undefined;
  machine?: string | undefined;
  killed?: string[] | undefined;
}

export type DeletionPart = 'projects' | 'apps' | 'workspaces' | 'secrets' | 'repositories' | 'files' | 'records';

export interface PartProgress {
  state: 'deleting' | 'deleted';
  left?: number | undefined;
  deleted: number;
}

export type DeletionPhase = 'deleting' | 'archived' | 'deleted';

export interface DeletionProgress {
  seq: number;
  phase: DeletionPhase;
  work: StoppingWork[];
  parts: Partial<Record<DeletionPart, PartProgress>>;
  problem?: string | undefined;
  keptUntil?: string | undefined;
  down?: ServiceDown[] | undefined;
}

export interface ServiceDown {
  step: string;
  dependency: string;
  name: string;
  since: string;
  reason: string;
}

const PHASES: readonly DeletionPhase[] = ['deleting', 'archived', 'deleted'];

export function isDeletionProgress(raw: unknown): raw is DeletionProgress {
  const progress = raw as Partial<DeletionProgress> | null | undefined;
  return typeof progress === 'object' && progress !== null
    && typeof progress.seq === 'number' && PHASES.includes(progress.phase as DeletionPhase)
    && Array.isArray(progress.work) && typeof progress.parts === 'object' && progress.parts !== null;
}

export const SERVICE_DOWN_SIGNAL = 'service-down';
export const SERVICE_BACK_SIGNAL = 'service-back';

export function serviceDown(progress: DeletionProgress, down: ServiceDown): DeletionProgress {
  return next(progress, { down: [...(progress.down ?? []).filter((item) => item.step !== down.step), down] });
}

export function serviceBack(progress: DeletionProgress, step: string): DeletionProgress {
  return next(progress, { down: (progress.down ?? []).filter((item) => item.step !== step) });
}

const next = (progress: DeletionProgress, change: Partial<DeletionProgress>): DeletionProgress => {
  const { problem: _gone, ...rest } = progress;
  return { ...rest, ...change, seq: progress.seq + 1 };
};

export const deletionBegun = (seq = 0): DeletionProgress => ({ seq, phase: 'deleting', work: [], parts: {} });

export function workStopping(progress: DeletionProgress, open: readonly OpenWork[]): DeletionProgress {
  const listed = new Set(progress.work.map((item) => item.workflowId));
  const added = open.filter((work) => !listed.has(work.workflowId)).map((work): StoppingWork => ({ ...work, state: 'stopping' }));
  return next(progress, { work: [...progress.work, ...added] });
}

const closedAs = (frozen: readonly string[], machines: readonly string[]): Pick<StoppingWork, 'state' | 'worker' | 'machine'> => {
  const [machine] = machines;
  if (machine) return { state: 'waiting-machine', machine };
  const [worker] = frozen;
  return worker ? { state: 'restarting', worker } : { state: 'stopped' };
};

export function workClosed(progress: DeletionProgress, workflowId: string, frozen: readonly string[], killed: readonly string[] = [], machines: readonly string[] = []): DeletionProgress {
  const programs = killed.length > 0 ? { killed: [...killed] } : {};
  return next(progress, {
    work: progress.work.map((item) => (item.workflowId !== workflowId ? item : { ...item, ...programs, ...closedAs(frozen, machines) })),
  });
}

export function machineWorkStopped(progress: DeletionProgress, workflowId: string, killed: readonly string[]): DeletionProgress {
  return next(progress, {
    work: progress.work.map((item) => {
      if (item.workflowId !== workflowId || item.state !== 'waiting-machine') return item;
      const all = [...new Set([...(item.killed ?? []), ...killed])];
      return { ...item, ...(all.length > 0 ? { killed: all } : {}), state: 'stopped' };
    }),
  });
}

export function machineRemoved(progress: DeletionProgress, workflowId: string): DeletionProgress {
  return next(progress, {
    work: progress.work.map((item) => (item.workflowId === workflowId && item.state === 'waiting-machine' ? { ...item, state: 'machine-removed' } : item)),
  });
}

export function workerRestarted(progress: DeletionProgress, worker: string, answer: 'restarted' | 'not-here'): DeletionProgress {
  const state: WorkStopState = answer === 'restarted' ? 'restarted' : 'gone';
  return next(progress, { work: progress.work.map((item) => (item.worker === worker && item.state === 'restarting' ? { ...item, state } : item)) });
}

export function partDeleting(progress: DeletionProgress, part: DeletionPart, left?: number): DeletionProgress {
  const deleted = progress.parts[part]?.deleted ?? 0;
  return next(progress, { parts: { ...progress.parts, [part]: { state: 'deleting', ...(left === undefined ? {} : { left }), deleted } } });
}

export function appRemoved(progress: DeletionProgress): DeletionProgress {
  const apps = progress.parts.apps ?? { state: 'deleting', deleted: 0 };
  const left = apps.left === undefined ? undefined : Math.max(0, apps.left - 1);
  return next(progress, { parts: { ...progress.parts, apps: { state: 'deleting', ...(left === undefined ? {} : { left }), deleted: apps.deleted + 1 } } });
}

export function partDeleted(progress: DeletionProgress, part: DeletionPart, count: number): DeletionProgress {
  const deleted = (progress.parts[part]?.deleted ?? 0) + count;
  return next(progress, { parts: { ...progress.parts, [part]: { state: 'deleted', left: 0, deleted } } });
}

export type DeletionEnding = { phase: 'archived'; keptUntil: string } | { phase: 'deleted' };

export const deletionEnded = (progress: DeletionProgress, ending: DeletionEnding): DeletionProgress => next(progress, ending);

export const deletionStuck = (progress: DeletionProgress, problem: string): DeletionProgress => ({ ...next(progress, {}), problem });

export const laterThan = (progress: DeletionProgress, other: DeletionProgress | undefined): boolean => !other || progress.seq > other.seq;

export function namedWork(progress: DeletionProgress, title: (work: OpenWork) => string, earlier?: DeletionProgress): DeletionProgress {
  const known = new Map((earlier?.work ?? []).filter((item) => item.what).map((item) => [item.workflowId, item.what]));
  return { ...progress, work: progress.work.map((item) => ({ ...item, what: item.what ?? known.get(item.workflowId) ?? title(item) })) };
}
