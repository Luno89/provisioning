import { mkdir } from 'node:fs/promises';
import {
  EXTERNAL_SEGMENT_MS,
  type ExternalAgentAsk, type ExternalAgentStepArgs, type ExternalAgentStepResult, type ExternalAgentWireEvent, type ExternalServedTool, type ExternalToolCall,
} from '@koala/engine-core';
import { randomUUID } from 'node:crypto';
import { insideRoot, modelName, openAcpSession, type AcpLaunch, type AcpSession, type PermissionAnswer } from './acp-session.js';
import type { LocalMcpServer, LocalTool, Mounted } from './local-mcp.js';

export const KOALA_TOOLS_INSTRUCTIONS = 'Koala\'s own tools, served to you for this session. Each runs in Koala exactly as it would for Koala itself, so a proposal becomes a card for the person, and a call that changes something may wait for the person to allow it.';

export const TOOLS_LINE = 'Koala\'s tools are served to you through the MCP server named koala. When your instructions name one of Koala\'s tools, call it there; do not describe calling it, and do not do its work another way. Some of them take a long time: a call still running after a couple of minutes answers with a job id instead of its result, and keeps running in Koala; call wait_for with that job until it gives you the result, rather than calling the tool again.';

export const CALL_ANSWER_MS = 150_000;

export const JOB_WAIT_MS = 150_000;

export const WAIT_FOR = 'wait_for';

export const stillRunning = (tool: string, job: string): string =>
  `${tool} is still running in Koala as job ${job}. Call ${WAIT_FOR} with job "${job}" to get its result; do not call ${tool} again for it.`;

export const HEARTBEAT_EVERY_MS = 5000;

export const KOALA_SERVER = 'koala';

export function servesCall(served: readonly { name: string }[], tool: { title: string; kind: string }): boolean {
  if (tool.kind !== 'other') return false;
  const called = tool.title.trim().split(/\s/)[0] ?? '';
  return served.some((tool) => [`${KOALA_SERVER}_${tool.name}`, `mcp__${KOALA_SERVER}__${tool.name}`, `${KOALA_SERVER}.${tool.name}`, `${KOALA_SERVER}/${tool.name}`].includes(called));
}

const WORKING_DIR_FIELDS = ['workingDir', 'working_dir', 'WorkingDirectory', 'cwd', 'Cwd'];

export const workspaceLine = (folder: string): string =>
  `Your folder is ${folder}. Run every command from it (cd into it first) and keep every file you write inside it; nothing outside it is yours to change.`;

const fieldOf = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  for (const field of WORKING_DIR_FIELDS) {
    const found = (value as Record<string, unknown>)[field];
    if (typeof found === 'string' && found) return found;
  }
  return undefined;
};

export function workingDirOf(tool: { input?: unknown; output?: string | undefined }): string | undefined {
  const fromInput = fieldOf(tool.input);
  if (fromInput) return fromInput;
  if (!tool.output?.trimStart().startsWith('{')) return undefined;
  try {
    return fieldOf(JSON.parse(tool.output));
  } catch {
    return undefined;
  }
}

export type ExternalAgentLaunches = Record<string, AcpLaunch>;

interface Live {
  session: AcpSession;
  mounted?: Mounted | undefined;
  events: ExternalAgentWireEvent[];
  ask?: { ask: ExternalAgentAsk; answer: (answer: PermissionAnswer) => void } | undefined;
  calls: ExternalToolCall[];
  held: Map<string, { resolve: (content: string) => void; reject: (err: Error) => void }>;
  jobs: Map<string, Promise<{ content: string } | { error: Error }>>;
  ended?: { stopReason: string } | { error: string } | undefined;
  wake: () => void;
}

export interface ExternalAgentSessionsOptions {
  rootDir: string;
  launches: ExternalAgentLaunches;
  segmentMs?: number | undefined;
  mcp?: LocalMcpServer | undefined;
  callAnswerMs?: number | undefined;
  jobWaitMs?: number | undefined;
}

const NOT_ANSWERED = 'the run that offered this tool stopped before it answered';

function releaseHeld(live: Pick<Live, 'held' | 'calls' | 'jobs'>, why: string): void {
  for (const held of live.held.values()) held.reject(new Error(why));
  live.held.clear();
  live.calls.splice(0);
  live.jobs.clear();
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(undefined), ms);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (err: unknown) => { clearTimeout(timer); reject(err); },
  );
});

export class ExternalAgentSessions {
  private readonly live = new Map<string, Live>();
  private launches: ExternalAgentLaunches;

  constructor(private readonly options: ExternalAgentSessionsOptions) {
    this.launches = { ...options.launches };
  }

  agents(): string[] {
    return Object.keys(this.launches).sort();
  }

  setLaunches(launches: ExternalAgentLaunches): void {
    this.launches = { ...launches };
  }

  openKeys(): string[] {
    return [...this.live.keys()];
  }

  async step(args: ExternalAgentStepArgs, beat: () => void = () => {}): Promise<ExternalAgentStepResult> {
    const { op } = args;
    if (op.kind === 'open') return this.open(args.key, args.agent, op, beat);
    const live = this.live.get(args.key);
    if (!live) return { state: 'failed', error: 'that session is no longer open on this machine', events: [] };
    if (op.kind === 'close') {
      this.live.delete(args.key);
      releaseHeld(live, NOT_ANSWERED);
      live.mounted?.unmount();
      await live.session.close();
      return { ...this.about(live), state: 'closed', events: live.events.splice(0) };
    }
    const answers = op.kind === 'result' ? [op] : op.kind === 'results' ? op.results : [];
    for (const answer of answers) {
      const held = live.held.get(answer.callId);
      live.held.delete(answer.callId);
      if (!held) continue;
      if (answer.ok) held.resolve(answer.content);
      else held.reject(new Error(answer.content));
    }
    if (op.kind === 'cancel') {
      releaseHeld(live, 'the run was cancelled');
      live.ask?.answer({ cancelled: true });
      live.ask = undefined;
      await live.session.cancel();
    }
    if (op.kind === 'prompt') {
      if (!live.ended) return { ...this.about(live), state: 'failed', error: 'the agent is still working on its last prompt', events: live.events.splice(0) };
      live.ended = undefined;
      live.session.prompt(op.text).then(
        (reply) => { live.ended = { stopReason: reply.stopReason }; },
        (err: unknown) => { live.ended = { error: (err as Error).message }; },
      ).finally(() => live.wake());
    }
    if (op.kind === 'answer' && live.ask) {
      const pending = live.ask;
      live.ask = undefined;
      pending.answer(op.optionId ? { optionId: op.optionId } : { cancelled: true });
    }
    return this.segment(live, beat, op.kind === 'continue' ? op.within : undefined);
  }

  async closeAll(): Promise<void> {
    const open = [...this.live.values()];
    this.live.clear();
    for (const live of open) {
      releaseHeld(live, NOT_ANSWERED);
      live.mounted?.unmount();
    }
    await Promise.all(open.map((live) => live.session.close()));
  }

  private async open(key: string, agent: string, op: Extract<ExternalAgentStepArgs['op'], { kind: 'open' }>, beat: () => void): Promise<ExternalAgentStepResult> {
    if (this.live.has(key)) return { state: 'failed', error: 'that session is already open on this machine', events: [] };
    const launch = this.launches[agent];
    if (!launch) {
      const known = this.agents();
      return { state: 'failed', error: `this machine has no agent called ${agent}${known.length ? ` (it has ${known.join(', ')})` : ''}`, events: [] };
    }
    const cwd = insideRoot(this.options.rootDir, op.path ?? '.');
    if (!cwd) return { state: 'failed', error: `${op.path} is outside this machine's folder`, events: [] };
    await mkdir(cwd, { recursive: true });

    const live: Partial<Live> & Pick<Live, 'events' | 'wake' | 'calls' | 'held' | 'jobs'> = { events: [], calls: [], held: new Map(), jobs: new Map(), wake: () => {} };
    const strays = new Set<string>();
    const watch = (event: ExternalAgentWireEvent) => {
      live.events.push(event);
      if (event.type !== 'tool' || strays.has(event.tool.callId)) return;
      const workingDir = workingDirOf(event.tool);
      if (!workingDir || insideRoot(cwd, workingDir)) return;
      strays.add(event.tool.callId);
      live.events.push({ type: 'stray', callId: event.tool.callId, title: event.tool.title, workingDir, folder: cwd });
    };
    const offered = (op.tools ?? []).map((tool): LocalTool => this.serve(live, tool));
    const served = offered.length ? [...offered, this.waitFor(live)] : offered;
    const mounted = this.options.mcp && served.length ? this.options.mcp.mount(served, KOALA_TOOLS_INSTRUCTIONS) : undefined;
    let session: AcpSession;
    try {
      session = await openAcpSession({
        launch,
        cwd,
        ...(mounted ? { mcpServers: [{ type: 'http', name: KOALA_SERVER, url: mounted.url, headers: [] }] } : {}),
        ...(op.resume ? { resume: op.resume } : {}),
        onEvent: watch,
        onPermission: (ask) => {
          const allow = ask.options.find((option) => option.kind === 'allow_once');
          if (allow && servesCall(served, ask.tool)) return Promise.resolve({ optionId: allow.optionId });
          return new Promise<PermissionAnswer>((resolve) => {
            live.ask = { ask, answer: resolve };
            live.wake();
          });
        },
      });
    } catch (err) {
      mounted?.unmount();
      return { state: 'failed', error: (err as Error).message, events: [] };
    }
    const opened = Object.assign(live, { session, mounted }) as Live;

    if (op.model) {
      try {
        await session.setModel(op.model);
      } catch (err) {
        mounted?.unmount();
        await session.close();
        return { state: 'failed', error: (err as Error).message, events: [] };
      }
    }

    if (op.mode && session.modes && op.mode !== session.modes.current) {
      if (!session.modes.available.some((mode) => mode.id === op.mode)) {
        mounted?.unmount();
        await session.close();
        return { state: 'failed', error: `${agent} has no ${op.mode} mode (it has ${session.modes.available.map((mode) => mode.id).join(', ')})`, events: [] };
      }
      await session.setMode(op.mode);
    }

    this.live.set(key, opened);
    const opening = [workspaceLine(cwd), mounted ? TOOLS_LINE : '', op.context].filter(Boolean).join('\n\n');
    const text = session.resumed ? op.brief : `${opening}\n\n${op.brief}`;
    session.prompt(text).then(
      (reply) => { opened.ended = { stopReason: reply.stopReason }; },
      (err: unknown) => { opened.ended = { error: (err as Error).message }; },
    ).finally(() => opened.wake());
    return this.segment(opened, beat);
  }

  private segment(live: Live, beat: () => void, within?: number): Promise<ExternalAgentStepResult> {
    const limit = Math.min(this.options.segmentMs ?? EXTERNAL_SEGMENT_MS, within ?? Number.POSITIVE_INFINITY);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        clearInterval(beating);
        live.wake = () => {};
        resolve(this.result(live));
      };
      const ready = () => Boolean(live.ask || live.calls.length || live.ended);
      const timer = setTimeout(done, limit);
      const beating = setInterval(beat, Math.min(HEARTBEAT_EVERY_MS, limit / 2));
      live.wake = () => { if (ready()) done(); };
      if (ready()) done();
    });
  }

  private result(live: Live): ExternalAgentStepResult {
    const base = { ...this.about(live), events: live.events.splice(0) };
    if (live.ask) return { ...base, state: 'asks', ask: live.ask.ask };
    const calls = live.calls.splice(0);
    if (calls.length) return { ...base, state: 'calls', calls };
    if (live.ended && 'error' in live.ended) return { ...base, state: 'failed', error: live.ended.error };
    if (live.ended) return { ...base, state: 'ended', stopReason: live.ended.stopReason };
    return { ...base, state: 'running' };
  }

  private about(live: Live) {
    const models = live.session.models;
    return {
      identity: live.session.identity,
      sessionId: live.session.sessionId,
      ...(models ? { model: { id: models.current, name: modelName(models) ?? models.current } } : {}),
    };
  }

  private serve(live: Pick<Live, 'calls' | 'held' | 'wake' | 'jobs'>, tool: ExternalServedTool): LocalTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      run: async (args) => {
        const callId = randomUUID();
        const answered = new Promise<string>((resolve, reject) => {
          live.held.set(callId, { resolve, reject });
          live.calls.push({ callId, name: tool.name, arguments: JSON.stringify(args) });
          live.wake();
        });
        const settled = answered.then((content) => ({ content }), (error: Error) => ({ error }));
        const done = await within(settled, this.options.callAnswerMs ?? CALL_ANSWER_MS);
        if (!done) {
          live.jobs.set(callId, settled);
          return stillRunning(tool.name, callId);
        }
        if ('error' in done) throw done.error;
        return done.content;
      },
    };
  }

  private waitFor(live: Pick<Live, 'jobs'>): LocalTool {
    return {
      name: WAIT_FOR,
      description: 'Waits for a Koala tool call that is still running, given the job its first answer named, and gives you its result. If it is still running after a couple of minutes, it says so; call it again.',
      inputSchema: { type: 'object', properties: { job: { type: 'string', description: 'The job id a call answered with.' } }, required: ['job'] },
      run: async (args) => {
        const job = String(args.job ?? '');
        const pending = live.jobs.get(job);
        if (!pending) throw new Error(`there is no running job ${job}; it may already have been collected`);
        const done = await within(pending, this.options.jobWaitMs ?? JOB_WAIT_MS);
        if (!done) return `job ${job} is still running in Koala; call ${WAIT_FOR} with it again.`;
        live.jobs.delete(job);
        if ('error' in done) throw done.error;
        return done.content;
      },
    };
  }
}
