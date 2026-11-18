export const PROGRESS_STATES = ['started', 'done', 'already-done', 'failed'] as const;

export type ProgressState = (typeof PROGRESS_STATES)[number];

export interface MachineProgress {
  stage: string;
  title: string;
  state: ProgressState;
  why?: string;
  line?: string;
  url?: string;
}

export const PROGRESS_LIMITS = { stage: 64, title: 200, why: 4000, line: 500, url: 2048 } as const;

export interface ProgressContract {
  lines: boolean;
  lastStage?: string;
}

export type ProgressRead = { ok: true; value: MachineProgress } | { ok: false; problem: string };

export const progressCredential = (secret: string): { authorization: string } => ({ authorization: `Bearer ${secret}` });

const STAGE = /^[a-z][a-z0-9-]*$/;
const SHORTENED = '… (shortened)';

const bounded = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - SHORTENED.length)}${SHORTENED}`);

export const boundedWhy = (why: string): string => bounded(why, PROGRESS_LIMITS.why);

export const boundedLine = (line: string): string => bounded(line, PROGRESS_LIMITS.line);

const keysOf = (contract: ProgressContract): string[] => ['stage', 'title', 'state', 'why', ...(contract.lines ? ['line'] : []), ...(contract.lastStage ? ['url'] : [])];

const listed = (names: readonly string[]): string => {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
};

const textProblem = (value: unknown, name: keyof typeof PROGRESS_LIMITS): string | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return `"${name}" is a non-empty string`;
  if (value.length > PROGRESS_LIMITS[name]) return `"${name}" is at most ${PROGRESS_LIMITS[name]} characters`;
  return undefined;
};

const stageProblem = (value: unknown): string | undefined =>
  textProblem(value, 'stage') ?? (STAGE.test(value as string) ? undefined : '"stage" is a name in lowercase letters, digits and dashes');

const finished = (state: ProgressState): boolean => state === 'done' || state === 'already-done';

function optionalProblem(body: Record<string, unknown>, state: ProgressState, contract: ProgressContract): string | undefined {
  if (state === 'failed') {
    const why = textProblem(body.why, 'why');
    if (why) return `a failure says why: ${why}`;
  } else if (body.why !== undefined) {
    return 'only a failure has "why"';
  }
  if (body.line !== undefined) {
    if (state !== 'started') return 'only a stage under way has "line"';
    const line = textProblem(body.line, 'line');
    if (line) return line;
  }
  const last = contract.lastStage !== undefined && body.stage === contract.lastStage && finished(state);
  if (last) {
    const url = textProblem(body.url, 'url');
    if (url) return `the last stage, done, says where Koala answers: ${url}`;
  } else if (body.url !== undefined) {
    return 'only the last stage, done, has "url"';
  }
  return undefined;
}

export function progressOf(raw: unknown, contract: ProgressContract): ProgressRead {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'send an object with "stage", "title" and "state"' };
  const body = raw as Record<string, unknown>;
  const keys = keysOf(contract);
  const extra = Object.keys(body).filter((key) => !keys.includes(key));
  if (extra.length > 0) return { ok: false, problem: `only ${listed(keys)} are taken, not ${extra.map((key) => `"${key}"`).join(', ')}` };
  const problem = stageProblem(body.stage) ?? textProblem(body.title, 'title');
  if (problem) return { ok: false, problem };
  if (!PROGRESS_STATES.includes(body.state as ProgressState)) return { ok: false, problem: `"state" is one of ${PROGRESS_STATES.join(', ')}` };
  const state = body.state as ProgressState;
  const optional = optionalProblem(body, state, contract);
  if (optional) return { ok: false, problem: optional };
  return {
    ok: true,
    value: {
      stage: body.stage as string,
      title: body.title as string,
      state,
      ...(body.why !== undefined ? { why: body.why as string } : {}),
      ...(body.line !== undefined ? { line: body.line as string } : {}),
      ...(body.url !== undefined ? { url: body.url as string } : {}),
    },
  };
}

export interface ProgressCases {
  accepted: MachineProgress[];
  refused: { body: unknown; problem: string }[];
}

export function progressCases(contract: ProgressContract): ProgressCases {
  const keys = keysOf(contract);
  const accepted: MachineProgress[] = [
    { stage: 'join', title: 'Joining Koala', state: 'started' },
    { stage: 'mesh', title: 'Joining your private network', state: 'already-done' },
    { stage: 'k3s', title: 'Installing k3s, stopped until there is work', state: 'done' },
    { stage: 'nvidia-cdi', title: 'Installing NVIDIA\'s CDI support', state: 'failed', why: 'apt-get install exited with 100' },
    { stage: `s${'a'.repeat(PROGRESS_LIMITS.stage - 1)}`, title: 't'.repeat(PROGRESS_LIMITS.title), state: 'failed', why: 'w'.repeat(PROGRESS_LIMITS.why) },
  ];
  const refused: { body: unknown; problem: string }[] = [
    { body: null, problem: 'send an object with "stage", "title" and "state"' },
    { body: 'k3s started', problem: 'send an object with "stage", "title" and "state"' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'x', tail: ['secret'] }, problem: `only ${listed(keys)} are taken, not "tail"` },
    { body: { title: 'Installing k3s', state: 'done' }, problem: '"stage" is a non-empty string' },
    { body: { stage: 'Install K3S!', title: 'Installing k3s', state: 'done' }, problem: '"stage" is a name in lowercase letters, digits and dashes' },
    { body: { stage: 'k'.repeat(PROGRESS_LIMITS.stage + 1), title: 'Installing k3s', state: 'done' }, problem: '"stage" is at most 64 characters' },
    { body: { stage: 'k3s', title: '', state: 'done' }, problem: '"title" is a non-empty string' },
    { body: { stage: 'k3s', title: '   ', state: 'done' }, problem: '"title" is a non-empty string' },
    { body: { stage: 'k3s', title: 't'.repeat(PROGRESS_LIMITS.title + 1), state: 'done' }, problem: '"title" is at most 200 characters' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'finished' }, problem: '"state" is one of started, done, already-done, failed' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'failed' }, problem: 'a failure says why: "why" is a non-empty string' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'w'.repeat(PROGRESS_LIMITS.why + 1) }, problem: 'a failure says why: "why" is at most 4000 characters' },
    { body: { stage: 'k3s', title: 'Installing k3s', state: 'done', why: 'it worked' }, problem: 'only a failure has "why"' },
  ];
  if (contract.lines) {
    accepted.push({ stage: 'k3s', title: 'Installing k3s', state: 'started', line: 'deployment/instance-backend has 0 of 1 available' });
    accepted.push({ stage: 'k3s', title: 'Installing k3s', state: 'started', line: 'l'.repeat(PROGRESS_LIMITS.line) });
    refused.push({ body: { stage: 'k3s', title: 'Installing k3s', state: 'done', line: 'all up' }, problem: 'only a stage under way has "line"' });
    refused.push({ body: { stage: 'k3s', title: 'Installing k3s', state: 'started', line: '' }, problem: '"line" is a non-empty string' });
    refused.push({ body: { stage: 'k3s', title: 'Installing k3s', state: 'started', line: 'l'.repeat(PROGRESS_LIMITS.line + 1) }, problem: '"line" is at most 500 characters' });
  } else {
    refused.push({ body: { stage: 'k3s', title: 'Installing k3s', state: 'started', line: 'k3s says hello' }, problem: `only ${listed(keys)} are taken, not "line"` });
  }
  if (contract.lastStage) {
    const last = contract.lastStage;
    accepted.push({ stage: last, title: 'The last stage', state: 'done', url: 'https://bo.koala.test' });
    accepted.push({ stage: last, title: 'The last stage', state: 'already-done', url: 'http://100.64.0.7:30320' });
    refused.push({ body: { stage: last, title: 'The last stage', state: 'done' }, problem: 'the last stage, done, says where Koala answers: "url" is a non-empty string' });
    refused.push({ body: { stage: 'k3s', title: 'Installing k3s', state: 'done', url: 'https://bo.koala.test' }, problem: 'only the last stage, done, has "url"' });
    refused.push({ body: { stage: last, title: 'The last stage', state: 'started', url: 'https://bo.koala.test' }, problem: 'only the last stage, done, has "url"' });
  } else {
    refused.push({ body: { stage: 'k3s', title: 'Installing k3s', state: 'done', url: 'https://bo.koala.test' }, problem: `only ${listed(keys)} are taken, not "url"` });
  }
  return { accepted, refused };
}
