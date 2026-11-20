import { passedOn, PERSON_SESSION } from '@koala/engine-core/child-env';
import { ignore } from '@koala/engine-core/failures';
import { nodeStreams } from '@koala/engine-core/node-processes';
import { ProcessNotStarted, type Followed, type Streams } from '@koala/engine-core/processes';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
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
  streams?: Streams | undefined;
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

export const AGENT_SIGN_IN = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY', 'CODEX_HOME',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

const agentEnv = (launch: AcpLaunch): Record<string, string> => ({ ...passedOn([...PERSON_SESSION, ...AGENT_SIGN_IN]), ...launch.env });

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

type Exit = { code: number | null; signal: NodeJS.Signals | null };

interface AgentChild {
  running: Followed;
  stderr: string[];
  exited: Promise<Exit>;
  spawnFailed: Promise<never>;
  stream: ReturnType<typeof ndJsonStream>;
  stop(): Promise<void>;
}

function startAgent(streams: Streams, launch: AcpLaunch, cwd: string): AgentChild {
  const toAgent = new PassThrough();
  const fromAgent = new Readable({ read: () => undefined });
  const stderr: string[] = [];
  const running = streams.start({ command: launch.command, args: launch.args, cwd, env: agentEnv(launch) }, {
    input: toAgent,
    heard: {
      stdout: (chunk) => { fromAgent.push(Buffer.from(chunk, 'utf8')); },
      stderr: (chunk) => {
        stderr.push(...chunk.split('\n').filter(Boolean));
        if (stderr.length > STDERR_LINES) stderr.splice(0, stderr.length - STDERR_LINES);
      },
    },
  });
  const spawnFailed = running.ended.then(
    (): Promise<never> => new Promise<never>(() => undefined),
    (err: unknown): never => {
      throw new AcpSessionError(err instanceof ProcessNotStarted ? `could not start ${launch.command}: ${err.reason}` : (err as Error).message, '');
    },
  );
  void running.ended.finally(() => { fromAgent.push(null); }).catch(ignore('a failed start reaches the session through spawnFailed'));
  const exited = running.exited.then(
    (end): Exit => ({ code: end.signal !== undefined ? null : end.code, signal: (end.signal ?? null) as NodeJS.Signals | null }),
    (): Promise<Exit> => new Promise<Exit>(() => undefined),
  );
  const stream = ndJsonStream(
    Writable.toWeb(toAgent) as WritableStream<Uint8Array>,
    Readable.toWeb(fromAgent) as ReadableStream<Uint8Array>,
  );
  const stop = async (): Promise<void> => {
    running.stop('SIGTERM');
    const timer = setTimeout(() => running.stop('SIGKILL'), CLOSE_GRACE_MS);
    await Promise.race([exited, spawnFailed.catch(ignore('a program that never started has nothing to stop'))]);
    clearTimeout(timer);
  };
  return { running, stderr, exited, spawnFailed, stream, stop };
}

export async function openAcpSession(options: AcpSessionOptions): Promise<AcpSession> {
  const { stderr, exited, spawnFailed, stream, stop } = startAgent(options.streams ?? nodeStreams, options.launch, options.cwd);
  const endedEarly = exited.then(({ code, signal }) => {
    throw new AcpSessionError(`${options.launch.command} exited (${signal ?? code}) before the session opened`, stderr.join('\n'));
  });

  const events = new AgentEvents();
  const pending = new Set<(answer: RequestPermissionResponse) => void>();
  let replaying = false;
  let sessionId = '';

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
    await stop();
    if (err instanceof AcpSessionError) throw err;
    throw new AcpSessionError((err as Error).message, stderr.join('\n'));
  }
  void spawnFailed.catch(ignore('only the opening raced it, and the session follows the child through exited from here'));
  void endedEarly.catch(ignore('only the opening raced it, and the session follows the child through exited from here'));

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
      await stop();
    },
    exited,
  };
}

export interface AcpProbe {
  identity: AgentIdentity;
  signIn: string[];
  models?: AgentModels | undefined;
}

export async function probeAcp(launch: AcpLaunch, cwd: string, streams: Streams = nodeStreams): Promise<AcpProbe> {
  const { stderr, exited, spawnFailed, stream, stop } = startAgent(streams, launch, cwd);
  const endedEarly = exited.then(({ code, signal }) => {
    throw new AcpSessionError(`${launch.command} exited (${signal ?? code}) without answering as an ACP agent`, stderr.join('\n'));
  });
  const connection = new ClientSideConnection(() => ({
    async sessionUpdate() {},
    async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
  }), stream);
  try {
    const init = await Promise.race([
      connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'koala-local-agent', version: '1.0.0' } }),
      spawnFailed,
      endedEarly,
    ]);
    const info = init.agentInfo;
    const opened = await Promise.race([connection.newSession({ cwd, mcpServers: [] }), spawnFailed, endedEarly]).catch((err: Error) => {
      console.warn(`[koala-local-agent] ${launch.command} answered as an ACP agent but opened no session, so its models are not known: ${err.message}`);
      return undefined;
    });
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
    void spawnFailed.catch(ignore('the probe has its answer or its failure already, and the child is stopped next'));
    void endedEarly.catch(ignore('the probe has its answer or its failure already, and the child is stopped next'));
    await stop();
  }
}
