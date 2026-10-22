import { createHash } from 'node:crypto';
import { quoteArgument, type EnvironmentDriver, type ToolOutcome } from '@koala/engine-core';
import { McpClient, type Fetcher } from '../../engine/lib/mcp-client.js';
import { slugify } from '../../engine/lib/mcp-tools.js';
import type { EnvironmentHandleRef, RunTicket } from '../temporal/contracts.js';

export const SERVER_LOGS = '/tmp/.koala-servers';
const DEFAULT_PATH = '/mcp';

export interface ServingEnvironments {
  forRun(request: { ticket: RunTicket; environment?: EnvironmentHandleRef | undefined }): Promise<EnvironmentDriver | undefined>;
}

export interface ServedServer {
  name: string;
  start: string;
  port: number;
  path?: string | undefined;
}

export interface WorkspaceServers {
  call(request: { ticket: RunTicket; environment?: EnvironmentHandleRef | undefined; server: ServedServer; tool: string; args: Record<string, unknown>; signal?: AbortSignal | undefined }): Promise<ToolOutcome>;
}

const urlOf = (server: Pick<ServedServer, 'port' | 'path'>): string => `http://127.0.0.1:${server.port}${server.path ?? DEFAULT_PATH}`;

export function startScript(name: string, serves: Omit<ServedServer, 'name'>): string {
  const url = quoteArgument(urlOf(serves));
  const log = `${SERVER_LOGS}/${slugify(name)}.log`;
  return [
    'answers() { [ "$(curl -s -o /dev/null -w \'%{http_code}\' -X POST -H \'content-type: application/json\' --data \'{}\' ' + url + ' 2>/dev/null)" != "000" ]; }',
    'answers && exit 0',
    `mkdir -p ${SERVER_LOGS}`,
    `setsid nohup sh -c ${quoteArgument(serves.start)} > ${log} 2>&1 < /dev/null &`,
    'started=$!',
    'until answers; do kill -0 "$started" 2>/dev/null || break; sleep 1; done',
    'answers && exit 0',
    `echo "it stopped before anything answered on port ${serves.port}; the end of its log:"`,
    `tail -20 ${log}`,
    'exit 1',
  ].join('\n');
}

export function parseCurlReply(raw: string): { status: number; headers: Headers; body: string } {
  let rest = raw;
  for (;;) {
    const split = rest.search(/\r?\n\r?\n/);
    if (split < 0) throw new Error(`the server's reply could not be read: ${raw.slice(0, 200)}`);
    const head = rest.slice(0, split);
    const gap = rest.slice(split).match(/^\r?\n\r?\n/)![0].length;
    const [statusLine = '', ...lines] = head.split(/\r?\n/);
    const status = Number(statusLine.split(' ')[1]);
    rest = rest.slice(split + gap);
    if (status >= 100 && status < 200) continue;
    const headers = new Headers();
    for (const line of lines) {
      const at = line.indexOf(':');
      if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    return { status, headers, body: rest };
  }
}

export function execFetch(driver: EnvironmentDriver, signal: () => AbortSignal | undefined = () => undefined): Fetcher {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.entries((init?.headers ?? {}) as Record<string, string>)
      .map(([key, value]) => `-H ${quoteArgument(`${key}: ${value}`)}`)
      .join(' ');
    const body = Buffer.from(String(init?.body ?? ''), 'utf8').toString('base64');
    const command = `printf '%s' ${quoteArgument(body)} | base64 -d | curl -sS -i -X ${init?.method ?? 'POST'} ${headers} --data-binary @- ${quoteArgument(url)}`;
    const stop = signal();
    const result = await driver.exec({ command, ...(stop ? { signal: stop } : {}) });
    if (result.exitCode !== 0) throw new Error(`curl in the workspace failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    const reply = parseCurlReply(result.stdout);
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }) as Fetcher;
}

const serverKey = (ticket: RunTicket, environment: EnvironmentHandleRef | undefined, server: ServedServer): string =>
  `${ticket.ownerId}:${environment?.id ?? ticket.runId}:${server.name}:${createHash('sha256').update(JSON.stringify([server.start, server.port, server.path ?? DEFAULT_PATH])).digest('hex').slice(0, 16)}`;

export function createWorkspaceServers(options: { environments: ServingEnvironments }): WorkspaceServers {
  const clients = new Map<string, { client: McpClient; stop: { signal?: AbortSignal | undefined } }>();

  const ensure = async (driver: EnvironmentDriver, server: ServedServer, signal?: AbortSignal): Promise<string | undefined> => {
    const started = await driver.exec({ command: startScript(server.name, server), ...(signal ? { signal } : {}) });
    return started.exitCode === 0 ? undefined : (started.stdout + started.stderr).trim() || `it exited ${started.exitCode}`;
  };

  const clientFor = (key: string, driver: EnvironmentDriver, server: ServedServer, signal?: AbortSignal): McpClient => {
    const found = clients.get(key);
    if (found) {
      found.stop.signal = signal;
      return found.client;
    }
    const stop: { signal?: AbortSignal | undefined } = { signal };
    const client = new McpClient(urlOf(server), execFetch(driver, () => stop.signal), 0);
    clients.set(key, { client, stop });
    return client;
  };

  return {
    async call({ ticket, environment, server, tool, args, signal }) {
      const refused = (why: string): ToolOutcome => ({ ok: false, digest: why, content: why });
      const driver = await options.environments.forRun({ ticket, ...(environment ? { environment } : {}) });
      if (!driver) return refused(`${server.name} runs in a workspace, and this run has none`);
      const failed = await ensure(driver, server, signal);
      if (failed) return refused(`${server.name} could not be started in the workspace: ${failed}`);
      const key = serverKey(ticket, environment, server);
      try {
        let out: { text: string; isError: boolean };
        try {
          out = await clientFor(key, driver, server, signal).callTool(tool, args);
        } catch {
          clients.delete(key);
          out = await clientFor(key, driver, server, signal).callTool(tool, args);
        }
        return { ok: !out.isError, digest: out.text, content: out.text };
      } catch (err) {
        return refused(`${server.name} did not answer ${tool}: ${(err as Error).message}`);
      }
    },
  };
}
