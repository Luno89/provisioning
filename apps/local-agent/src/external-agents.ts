import { mkdir } from 'node:fs/promises';
import {
  EXTERNAL_SEGMENT_MS,
  type ExternalAgentAsk, type ExternalAgentStepArgs, type ExternalAgentStepResult, type ExternalAgentWireEvent,
} from '@koala/engine-core';
import { insideRoot, openAcpSession, type AcpLaunch, type AcpSession, type PermissionAnswer } from './acp-session.js';
import type { LocalMcpServer, LocalTool, Mounted } from './local-mcp.js';

export const KOALA_TOOLS_INSTRUCTIONS = 'Koala\'s own tools, read-only. search_memories finds what Koala has learned before about this person\'s work; search it before guessing how something here is done.';

export const HEARTBEAT_EVERY_MS = 5000;

export function koalaTools(searchMemories: (query: string) => Promise<string>): LocalTool[] {
  return [{
    name: 'search_memories',
    description: 'Search what Koala has learned before about this person\'s projects and how their work is done: facts about their environment, lessons from earlier runs, guidance they gave. Read-only.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for.' } }, required: ['query'] },
    run: async (args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'Give a query: words to look for.';
      return searchMemories(query);
    },
  }];
}

const WORKING_DIR_FIELDS = ['workingDir', 'working_dir', 'WorkingDirectory', 'cwd', 'Cwd'];

export const workspaceLine = (folder: string): string =>
  `Your workspace is the folder ${folder}. Run every command from it (cd into it first) and keep every file you write inside it; nothing outside it is yours to change.`;

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

export function launchesFrom(raw: string | undefined): ExternalAgentLaunches {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as Record<string, { command?: unknown; args?: unknown; env?: unknown }>;
  const launches: ExternalAgentLaunches = {};
  for (const [id, entry] of Object.entries(parsed)) {
    if (typeof entry?.command !== 'string' || !entry.command) throw new Error(`external agent ${id} needs a command`);
    const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
    const env = entry.env && typeof entry.env === 'object' ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : undefined;
    launches[id] = { command: entry.command, args, ...(env ? { env } : {}) };
  }
  return launches;
}

interface Live {
  session: AcpSession;
  mounted?: Mounted | undefined;
  events: ExternalAgentWireEvent[];
  ask?: { ask: ExternalAgentAsk; answer: (answer: PermissionAnswer) => void } | undefined;
  ended?: { stopReason: string } | { error: string } | undefined;
  wake: () => void;
}

export interface ExternalAgentSessionsOptions {
  rootDir: string;
  launches: ExternalAgentLaunches;
  segmentMs?: number | undefined;
  mcp?: LocalMcpServer | undefined;
  tools?: LocalTool[] | undefined;
}

export class ExternalAgentSessions {
  private readonly live = new Map<string, Live>();

  constructor(private readonly options: ExternalAgentSessionsOptions) {}

  agents(): string[] {
    return Object.keys(this.options.launches).sort();
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
      live.mounted?.unmount();
      await live.session.close();
      return { ...this.about(live), state: 'closed', events: live.events.splice(0) };
    }
    if (op.kind === 'cancel') {
      live.ask?.answer({ cancelled: true });
      live.ask = undefined;
      await live.session.cancel();
    }
    if (op.kind === 'answer' && live.ask) {
      const pending = live.ask;
      live.ask = undefined;
      pending.answer(op.optionId ? { optionId: op.optionId } : { cancelled: true });
    }
    return this.segment(live, beat);
  }

  async closeAll(): Promise<void> {
    const open = [...this.live.values()];
    this.live.clear();
    for (const live of open) live.mounted?.unmount();
    await Promise.all(open.map((live) => live.session.close()));
  }

  private async open(key: string, agent: string, op: Extract<ExternalAgentStepArgs['op'], { kind: 'open' }>, beat: () => void): Promise<ExternalAgentStepResult> {
    if (this.live.has(key)) return { state: 'failed', error: 'that session is already open on this machine', events: [] };
    const launch = this.options.launches[agent];
    if (!launch) {
      const known = this.agents();
      return { state: 'failed', error: `this machine has no agent called ${agent}${known.length ? ` (it has ${known.join(', ')})` : ''}`, events: [] };
    }
    const cwd = insideRoot(this.options.rootDir, op.path ?? '.');
    if (!cwd) return { state: 'failed', error: `${op.path} is outside this machine's folder`, events: [] };
    await mkdir(cwd, { recursive: true });

    const live: Partial<Live> & { events: ExternalAgentWireEvent[]; wake: () => void } = { events: [], wake: () => {} };
    const strays = new Set<string>();
    const watch = (event: ExternalAgentWireEvent) => {
      live.events.push(event);
      if (event.type !== 'tool' || strays.has(event.tool.callId)) return;
      const workingDir = workingDirOf(event.tool);
      if (!workingDir || insideRoot(cwd, workingDir)) return;
      strays.add(event.tool.callId);
      live.events.push({ type: 'stray', callId: event.tool.callId, title: event.tool.title, workingDir, folder: cwd });
    };
    const mounted = this.options.mcp && this.options.tools?.length ? this.options.mcp.mount(this.options.tools, KOALA_TOOLS_INSTRUCTIONS) : undefined;
    let session: AcpSession;
    try {
      session = await openAcpSession({
        launch,
        cwd,
        ...(mounted ? { mcpServers: [{ type: 'http', name: 'koala', url: mounted.url, headers: [] }] } : {}),
        ...(op.resume ? { resume: op.resume } : {}),
        onEvent: watch,
        onPermission: (ask) => new Promise<PermissionAnswer>((resolve) => {
          live.ask = { ask, answer: resolve };
          live.wake();
        }),
      });
    } catch (err) {
      mounted?.unmount();
      return { state: 'failed', error: (err as Error).message, events: [] };
    }
    const opened = Object.assign(live, { session, mounted }) as Live;

    if (op.mode && session.modes && op.mode !== session.modes.current) {
      if (!session.modes.available.some((mode) => mode.id === op.mode)) {
        mounted?.unmount();
        await session.close();
        return { state: 'failed', error: `${agent} has no ${op.mode} mode (it has ${session.modes.available.map((mode) => mode.id).join(', ')})`, events: [] };
      }
      await session.setMode(op.mode);
    }

    this.live.set(key, opened);
    const opening = [workspaceLine(cwd), op.context].filter(Boolean).join('\n\n');
    const text = session.resumed ? op.brief : `${opening}\n\n${op.brief}`;
    session.prompt(text).then(
      (reply) => { opened.ended = { stopReason: reply.stopReason }; },
      (err: unknown) => { opened.ended = { error: (err as Error).message }; },
    ).finally(() => opened.wake());
    return this.segment(opened, beat);
  }

  private segment(live: Live, beat: () => void): Promise<ExternalAgentStepResult> {
    const limit = this.options.segmentMs ?? EXTERNAL_SEGMENT_MS;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        clearInterval(beating);
        live.wake = () => {};
        resolve(this.result(live));
      };
      const ready = () => Boolean(live.ask || live.ended);
      const timer = setTimeout(done, limit);
      const beating = setInterval(beat, Math.min(HEARTBEAT_EVERY_MS, limit / 2));
      live.wake = () => { if (ready()) done(); };
      if (ready()) done();
    });
  }

  private result(live: Live): ExternalAgentStepResult {
    const base = { ...this.about(live), events: live.events.splice(0) };
    if (live.ask) return { ...base, state: 'asks', ask: live.ask.ask };
    if (live.ended && 'error' in live.ended) return { ...base, state: 'failed', error: live.ended.error };
    if (live.ended) return { ...base, state: 'ended', stopReason: live.ended.stopReason };
    return { ...base, state: 'running' };
  }

  private about(live: Live) {
    return { identity: live.session.identity, sessionId: live.session.sessionId };
  }
}
