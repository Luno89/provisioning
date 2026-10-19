import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError,
  type Agent, type StopReason, type ToolKind,
} from '@agentclientprotocol/sdk';

export interface ScriptMcpCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  progress?: boolean;
  follow?: boolean;
}

export type ScriptStep =
  | { say: string }
  | { echo: true }
  | { mcp: ScriptMcpCall | ScriptMcpCall[] }
  | { think: string }
  | { tool: { id: string; title: string; kind?: ToolKind; input?: unknown }; ask?: boolean; output?: string }
  | { write: { path: string; content: string } }
  | { read: { path: string } }
  | { wait: number }
  | { exit: number }
  | { tellModel: true }
  | { record: string };

export interface AgentScript {
  name: string;
  version: string;
  modes?: { current: string; available: { id: string; name: string }[] };
  models?: { current: string; available: { id: string; name: string }[] };
  turns: { steps: ScriptStep[]; stop?: StopReason; when?: string | string[] }[];
}

type McpAnswer = { id?: unknown; method?: string; result?: { content?: { text?: string }[] }; error?: { message: string } };

const STILL_RUNNING = /\bjob ([0-9a-f-]{36})\b/;

export async function callMcp(servers: { name: string; url: string }[], call: ScriptMcpCall, id: number): Promise<string> {
  let said = await callMcpOnce(servers, call, id);
  if (!call.follow) return said;
  let followed: string | undefined;
  for (let asked = 1; ; asked += 1) {
    const job = said.includes('still running') ? STILL_RUNNING.exec(said)?.[1] : undefined;
    if (!job) return followed ? `${said} (waited for job ${followed} ${asked - 1} times)` : said;
    followed = job;
    said = `${call.tool}: ${(await callMcpOnce(servers, { server: call.server, tool: 'wait_for', args: { job } }, id * 1000 + asked)).replace(/^wait_for: /, '')}`;
  }
}

async function callMcpOnce(servers: { name: string; url: string }[], call: ScriptMcpCall, id: number): Promise<string> {
  const server = servers.find((candidate) => candidate.name === call.server);
  if (!server) return `no ${call.server} server`;
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: call.progress ? 'application/json, text/event-stream' : 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: call.tool, arguments: call.args, ...(call.progress ? { _meta: { progressToken: `p-${id}` } } : {}) } }),
  });
  const body = await response.text();
  const messages: McpAnswer[] = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as McpAnswer)
    : [JSON.parse(body) as McpAnswer];
  const answer = messages.find((message) => message.id !== undefined) ?? {};
  const progress = messages.filter((message) => message.method === 'notifications/progress').length;
  const text = `${call.tool}: ${answer.result?.content?.[0]?.text ?? answer.error?.message ?? ''}`;
  return call.progress ? `${text} (${progress} progress)` : text;
}

export function turnFor(script: AgentScript, taken: number, asked: string): AgentScript['turns'][number] | undefined {
  const matching = script.turns.find((turn) => turn.when !== undefined && [turn.when].flat().every((phrase) => asked.includes(phrase)));
  if (matching) return matching;
  return script.turns.filter((turn) => turn.when === undefined)[taken];
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function scriptedAgent(script: AgentScript, connection: AgentSideConnection): Agent {
  const sessions = new Map<string, { cwd: string; turn: number; abort?: AbortController; mode?: string; model?: string; servers?: { name: string; url: string }[] }>();
  const configOptions = (model: string | undefined) => (script.models
    ? [{ id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const, currentValue: model ?? script.models.current, options: script.models.available.map((entry) => ({ value: entry.id, name: entry.name })) }]
    : undefined);

  return {
    initialize: () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      agentInfo: { name: script.name, version: script.version },
      authMethods: [],
    }),
    authenticate: () => {},
    newSession: ({ cwd, mcpServers }) => {
      const sessionId = `scripted-${sessions.size + 1}`;
      const servers = mcpServers.flatMap((server) => ('url' in server ? [{ name: server.name, url: server.url }] : []));
      sessions.set(sessionId, { cwd, turn: 0, servers, ...(script.modes ? { mode: script.modes.current } : {}), ...(script.models ? { model: script.models.current } : {}) });
      const options = configOptions(script.models?.current);
      return { sessionId, ...(script.modes ? { modes: { currentModeId: script.modes.current, availableModes: script.modes.available } } : {}), ...(options ? { configOptions: options } : {}) };
    },
    loadSession: async ({ sessionId, cwd, mcpServers }) => {
      const known = sessions.get(sessionId);
      const servers = mcpServers.flatMap((server) => ('url' in server ? [{ name: server.name, url: server.url }] : []));
      sessions.set(sessionId, known ? { ...known, servers } : { cwd, turn: 0, servers });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } } });
      const options = configOptions(sessions.get(sessionId)?.model);
      return options ? { configOptions: options } : {};
    },
    setSessionConfigOption: async ({ sessionId, configId, value }) => {
      const session = sessions.get(sessionId);
      if (!session) throw RequestError.resourceNotFound(sessionId);
      if (configId !== 'model' || !script.models?.available.some((entry) => entry.id === value)) throw RequestError.invalidParams({ configId, value }, 'no such option');
      session.model = String(value);
      return { configOptions: configOptions(session.model) ?? [] };
    },
    setSessionMode: async ({ sessionId, modeId }) => {
      const session = sessions.get(sessionId);
      if (!session) throw RequestError.resourceNotFound(sessionId);
      session.mode = modeId;
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } });
    },
    cancel: ({ sessionId }) => {
      sessions.get(sessionId)?.abort?.abort();
    },
    prompt: async ({ sessionId, prompt }) => {
      const session = sessions.get(sessionId);
      if (!session) throw RequestError.resourceNotFound(sessionId);
      const asked = prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
      const turn = turnFor(script, session.turn, asked);
      session.turn += 1;
      if (!turn) return { stopReason: 'end_turn' };
      const abort = new AbortController();
      session.abort = abort;
      const send = (update: Parameters<AgentSideConnection['sessionUpdate']>[0]['update']) => connection.sessionUpdate({ sessionId, update });

      for (const step of turn.steps) {
        if (abort.signal.aborted) return { stopReason: 'cancelled' };
        if ('say' in step) await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.say } });
        else if ('echo' in step) await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: prompt.map((block) => (block.type === 'text' ? block.text : '')).join('') } });
        else if ('think' in step) await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.think } });
        else if ('wait' in step) await pause(step.wait, abort.signal);
        else if ('mcp' in step) {
          const said = await Promise.all((Array.isArray(step.mcp) ? step.mcp : [step.mcp]).map((call, index) => callMcp(session.servers ?? [], call, index + 1)));
          for (const text of said) await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        }
        else if ('exit' in step) process.exit(step.exit);
        else if ('record' in step) {
          const listed = await Promise.all((session.servers ?? []).map(async (server) => {
            const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
            const answer = await response.json() as { result?: { tools?: { name: string; description?: string; inputSchema?: unknown }[] } };
            return { server: server.name, tools: answer.result?.tools ?? [] };
          }));
          writeFileSync(step.record, JSON.stringify({ cwd: session.cwd, prompt: prompt.map((block) => (block.type === 'text' ? block.text : '')).join(''), servers: listed }, null, 2));
        }
        else if ('tellModel' in step) await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `on ${session.model ?? 'no model'}` } });
        else if ('write' in step) await connection.writeTextFile({ sessionId, path: path.resolve(session.cwd, step.write.path), content: step.write.content });
        else if ('read' in step) {
          const { content } = await connection.readTextFile({ sessionId, path: path.resolve(session.cwd, step.read.path) });
          await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `read: ${content}` } });
        } else {
          const { id, title, kind = 'other', input } = step.tool;
          await send({ sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'pending', ...(input === undefined ? {} : { rawInput: input }) });
          if (step.ask) {
            const answer = await connection.requestPermission({
              sessionId,
              toolCall: { toolCallId: id, title, kind },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ],
            });
            if (answer.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' };
            if (answer.outcome.optionId === 'reject') {
              await send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'the person declined' } }] });
              continue;
            }
          }
          await send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...(step.output ? { content: [{ type: 'content', content: { type: 'text', text: step.output } }] } : {}) });
        }
      }
      return { stopReason: abort.signal.aborted ? 'cancelled' : turn.stop ?? 'end_turn' };
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const scriptPath = process.argv[2];
  if (!scriptPath) throw new Error('usage: acp-script-agent <script.json>');
  const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as AgentScript;
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  new AgentSideConnection((connection) => scriptedAgent(script, connection), stream);
}
