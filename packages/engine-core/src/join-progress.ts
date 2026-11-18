export const JOIN_PROGRESS_PATH = '/api/machines/join-progress';

export const JOIN_PROGRESS_STATES = ['started', 'done', 'already-done', 'failed'] as const;

export type JoinProgressState = typeof JOIN_PROGRESS_STATES[number];

export interface JoinProgress {
  stage: string;
  title: string;
  state: JoinProgressState;
  why?: string;
}

export const JOIN_PROGRESS_LIMITS = { stage: 64, title: 200, why: 2000 } as const;

export const joinProgressCredential = (code: string): { authorization: string } => ({ authorization: `Bearer ${code}` });

export type JoinProgressRead = { ok: true; value: JoinProgress } | { ok: false; problem: string };

const KEYS = new Set(['stage', 'title', 'state', 'why']);

const textProblem = (value: unknown, name: keyof typeof JOIN_PROGRESS_LIMITS): string | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return `"${name}" is a non-empty string`;
  if (value.length > JOIN_PROGRESS_LIMITS[name]) return `"${name}" is at most ${JOIN_PROGRESS_LIMITS[name]} characters`;
  return undefined;
};

export function joinProgressOf(raw: unknown): JoinProgressRead {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'send an object with "stage", "title" and "state"' };
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => !KEYS.has(key));
  if (extra.length > 0) return { ok: false, problem: `only "stage", "title", "state" and "why" are taken, not ${extra.map((key) => `"${key}"`).join(', ')}` };
  const problem = textProblem(body.stage, 'stage') ?? textProblem(body.title, 'title');
  if (problem) return { ok: false, problem };
  if (!JOIN_PROGRESS_STATES.includes(body.state as JoinProgressState)) return { ok: false, problem: `"state" is one of ${JOIN_PROGRESS_STATES.join(', ')}` };
  const state = body.state as JoinProgressState;
  if (state === 'failed') {
    const why = textProblem(body.why, 'why');
    if (why) return { ok: false, problem: `a failure says why: ${why}` };
  } else if (body.why !== undefined) {
    return { ok: false, problem: 'only a failure has "why"' };
  }
  return { ok: true, value: { stage: body.stage as string, title: body.title as string, state, ...(state === 'failed' ? { why: body.why as string } : {}) } };
}

export const JOIN_PROGRESS_CASES = {
  accepted: [
    { stage: 'join', title: 'Joining Koala', state: 'started' },
    { stage: 'mesh', title: 'Joining your private network', state: 'already-done' },
    { stage: 'k3s', title: 'Installing k3s, stopped until there is work', state: 'done' },
    { stage: 'nvidia-cdi', title: 'Installing NVIDIA\'s CDI support', state: 'failed', why: 'apt-get install exited with 100' },
  ] satisfies JoinProgress[],
  refused: [
    { body: null, problem: 'send an object with "stage", "title" and "state"' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'x', tail: ['secret'] }, problem: 'only "stage", "title", "state" and "why" are taken, not "tail"' },
    { body: { title: 'Installing k3s', state: 'done' }, problem: '"stage" is a non-empty string' },
    { body: { stage: 'k3s', title: '', state: 'done' }, problem: '"title" is a non-empty string' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'finished' }, problem: '"state" is one of started, done, already-done, failed' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'failed' }, problem: 'a failure says why: "why" is a non-empty string' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'done', why: 'it worked' }, problem: 'only a failure has "why"' },
    { body: { stage: 'k'.repeat(65), title: 'Installing k3s', state: 'done' }, problem: '"stage" is at most 64 characters' },
  ],
} as const;
