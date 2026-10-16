import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError,
  type McpServer, type PermissionOptionKind, type RequestPermissionResponse, type SessionConfigOption, type StopReason,
} from '@agentclientprotocol/sdk';
import { AgentEvents, type AgentEvent, type ToolState } from './acp-events.js';

export const STDERR_LINES = 40;
export const CLOSE_GRACE_MS = 3000;
export const EXIT_WAIT_MS = 1000;

export interface AcpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

export interface AgentIdentity {
  name: string;
  title?: string | undefined;
  version?: string | undefined;
}

export interface PermissionAsk {
  tool: ToolState;
  options: { optionId: string; name: string; kind: PermissionOptionKind }[];
}

export type PermissionAnswer = { optionId: string } | { cancelled: true };

export interface SessionModes {
  current: string;
  available: { id: string; name: string; description?: string | undefined }[];
}

export interface AgentModels {
  configId: string;
  current: string;
  available: { id: string; name: string }[];
}

export function modelsOf(options: readonly SessionConfigOption[] | null | undefined): AgentModels | undefined {
  const option = (options ?? []).find((entry) => entry.type === 'select' && (entry.category === 'model' || entry.id === 'model'));
  if (!option || option.type !== 'select') return undefined;
  const flat = option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
  return { configId: option.id, current: option.currentValue, available: flat.map((entry) => ({ id: entry.value, name: entry.name })) };
}

export const modelName = (models: AgentModels | undefined): string | undefined =>
  models ? models.available.find((entry) => entry.id === models.current)?.name ?? models.current : undefined;

export interface AcpSessionOptions {
  launch: AcpLaunch;
  cwd: string;
  mcpServers?: McpServer[] | undefined;
  resume?: string | undefined;
  onEvent: (event: AgentEvent) => void;
  onPermission: (ask: PermissionAsk) => Promise<PermissionAnswer>;
}

export interface AcpSession {
  identity: AgentIdentity;
  sessionId: string;
  resumed: boolean;
  modes: SessionModes | undefined;
  models: AgentModels | undefined;
  prompt(text: string): Promise<{ stopReason: StopReason }>;
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<AgentModels>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class AcpSessionError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(stderr ? `${message}\n${stderr}` : message);
  }
}

export const insideRoot = (root: string, target: string): string | undefined => {
  const resolved = path.resolve(root, target);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : undefined;
};

const sliceLines = (text: string, line: number | null | undefined, limit: number | null | undefined): string => {
  if (!line && !limit) return text;
  const lines = text.split('\n');
  const start = Math.max(0, (line ?? 1) - 1);
  return lines.slice(start, limit ? start + limit : undefined).join('\n');
};

const stopChild = async (child: ChildProcess, exited: Promise<unknown>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), CLOSE_GRACE_MS);
  await exited;
  clearTimeout(timer);
};

export async function openAcpSession(options: AcpSessionOptions): Promise<AcpSession> {
  const child = spawn(options.launch.command, options.launch.args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.launch.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr.push(...chunk.split('\n').filter(Boolean));
    if (stderr.length > STDERR_LINES) stderr.splice(0, stderr.length - STDERR_LINES);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(new AcpSessionError(`could not start ${options.launch.command}: ${err.message}`, '')));
  });
  const endedEarly = exited.then(({ code, signal }) => {
    throw new AcpSessionError(`${options.launch.command} exited (${signal ?? code}) before the session opened`, stderr.join('\n'));
  });

  const events = new AgentEvents();
  const pending = new Set<(answer: RequestPermissionResponse) => void>();
  let replaying = false;
  let sessionId = '';

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const connection = new ClientSideConnection(() => ({
    async sessionUpdate(notification) {
      if (replaying || notification.sessionId !== sessionId) return;
      const event = events.read(notification.update);
      if (event) options.onEvent(event);
    },
    async requestPermission(request) {
      const seen = events.read({ sessionUpdate: 'tool_call_update', ...request.toolCall });
      const tool = seen?.type === 'tool' ? seen.tool : events.tool(request.toolCall.toolCallId)!;
      return new Promise<RequestPermissionResponse>((resolve) => {
        const settle = (answer: RequestPermissionResponse) => {
          if (!pending.delete(settle)) return;
          resolve(answer);
        };
        pending.add(settle);
        options.onPermission({ tool, options: request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })) }).then(
          (answer) => settle('cancelled' in answer ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: answer.optionId } }),
          () => settle({ outcome: { outcome: 'cancelled' } }),
        );
      });
    },
    async readTextFile({ path: wanted, line, limit }) {
      const inside = insideRoot(options.cwd, wanted);
      if (!inside) throw RequestError.invalidParams({ path: wanted }, `${wanted} is outside the session's folder`);
      return { content: sliceLines(await readFile(inside, 'utf8'), line, limit) };
    },
    async writeTextFile({ path: wanted, content }) {
      const inside = insideRoot(options.cwd, wanted);
      if (!inside) throw RequestError.invalidParams({ path: wanted }, `${wanted} is outside the session's folder`);
      await mkdir(path.dirname(inside), { recursive: true });
      await writeFile(inside, content, 'utf8');
      return {};
    },
  }), stream);

  const open = async () => {
    const init = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'koala-local-agent', version: '1.0.0' },
    });
    const mcp = init.agentCapabilities?.mcpCapabilities;
    const mcpServers = (options.mcpServers ?? []).filter((server) => !('type' in server) || (server.type === 'http' && mcp?.http) || (server.type === 'sse' && mcp?.sse));
    if (options.resume && init.agentCapabilities?.loadSession) {
      sessionId = options.resume;
      replaying = true;
      const loaded = await connection.loadSession({ sessionId: options.resume, cwd: options.cwd, mcpServers }).finally(() => { replaying = false; });
      return { init, sessionId: options.resume, modes: loaded?.modes, configOptions: loaded?.configOptions, resumed: true };
    }
    const created = await connection.newSession({ cwd: options.cwd, mcpServers });
    sessionId = created.sessionId;
    return { init, sessionId: created.sessionId, modes: created.modes, configOptions: created.configOptions, resumed: false };
  };

  let opened: Awaited<ReturnType<typeof open>>;
  try {
    opened = await Promise.race([open(), spawnFailed, endedEarly]);
  } catch (err) {
    await stopChild(child, exited);
    if (err instanceof AcpSessionError) throw err;
    throw new AcpSessionError((err as Error).message, stderr.join('\n'));
  }
  void spawnFailed.catch(() => {});
  void endedEarly.catch(() => {});

  const info = opened.init.agentInfo;
  const releasePending = () => {
    for (const settle of [...pending]) settle({ outcome: { outcome: 'cancelled' } });
  };

  let models = modelsOf(opened.configOptions);
  return {
    identity: { name: info?.name ?? options.launch.command, ...(info?.title ? { title: info.title } : {}), ...(info?.version ? { version: info.version } : {}) },
    sessionId: opened.sessionId,
    resumed: opened.resumed,
    modes: opened.modes
      ? { current: opened.modes.currentModeId, available: opened.modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name, ...(mode.description ? { description: mode.description } : {}) })) }
      : undefined,
    async prompt(text) {
      try {
        const reply = await connection.prompt({ sessionId, prompt: [{ type: 'text', text }] });
        return { stopReason: reply.stopReason };
      } catch (err) {
        const ended = await Promise.race([exited, new Promise<undefined>((resolve) => setTimeout(resolve, EXIT_WAIT_MS, undefined))]);
        if (ended) throw new AcpSessionError(`${options.launch.command} exited (${ended.signal ?? ended.code}) during the turn`, stderr.join('\n'));
        throw err;
      }
    },
    get models() {
      return models;
    },
    async setModel(modelId) {
      if (!models) throw new Error(`${options.launch.command} offers no choice of model`);
      if (!models.available.some((entry) => entry.id === modelId)) throw new Error(`${options.launch.command} has no model ${modelId} (it has ${models.available.map((entry) => entry.name).join(', ')})`);
      if (models.current !== modelId) {
        const answer = await connection.setSessionConfigOption({ sessionId, configId: models.configId, value: modelId });
        models = modelsOf(answer.configOptions) ?? { ...models, current: modelId };
      }
      return models;
    },
    async setMode(modeId) {
      await connection.setSessionMode({ sessionId, modeId });
    },
    async cancel() {
      releasePending();
      await connection.cancel({ sessionId });
    },
    async close() {
      releasePending();
      await stopChild(child, exited);
    },
    exited,
  };
}

export interface AcpProbe {
  identity: AgentIdentity;
  signIn: string[];
  models?: AgentModels | undefined;
}

export async function probeAcp(launch: AcpLaunch, cwd: string): Promise<AcpProbe> {
  const child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...(launch.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr: string[] = [];
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr.push(...chunk.split('\n').filter(Boolean));
    if (stderr.length > STDERR_LINES) stderr.splice(0, stderr.length - STDERR_LINES);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(new AcpSessionError(`could not start ${launch.command}: ${err.message}`, '')));
  });
  const endedEarly = exited.then(({ code, signal }) => {
    throw new AcpSessionError(`${launch.command} exited (${signal ?? code}) without answering as an ACP agent`, stderr.join('\n'));
  });
  const connection = new ClientSideConnection(() => ({
    async sessionUpdate() {},
    async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
  }), ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  ));
  try {
    const init = await Promise.race([
      connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'koala-local-agent', version: '1.0.0' } }),
      spawnFailed,
      endedEarly,
    ]);
    const info = init.agentInfo;
    const opened = await Promise.race([connection.newSession({ cwd, mcpServers: [] }), spawnFailed, endedEarly]).catch(() => undefined);
    const models = modelsOf(opened?.configOptions);
    return {
      ...(models ? { models } : {}),
      identity: { name: info?.name ?? path.basename(launch.command), ...(info?.title ? { title: info.title } : {}), ...(info?.version ? { version: info.version } : {}) },
      signIn: (init.authMethods ?? []).map((method) => method.name),
    };
  } catch (err) {
    if (err instanceof AcpSessionError) throw err;
    const ended = await Promise.race([exited, new Promise<undefined>((resolve) => setTimeout(resolve, EXIT_WAIT_MS, undefined))]);
    if (ended) throw new AcpSessionError(`${launch.command} exited (${ended.signal ?? ended.code}) without answering as an ACP agent`, stderr.join('\n'));
    throw new AcpSessionError((err as Error).message, stderr.join('\n'));
  } finally {
    void spawnFailed.catch(() => {});
    void endedEarly.catch(() => {});
    await stopChild(child, exited);
  }
}
