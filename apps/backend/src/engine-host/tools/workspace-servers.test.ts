import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { EnvironmentDriver, ExecRequest, ExecResult } from '@koala/engine-core';
import { MCP_SERVER_FILES } from '../../lib/project-templates.js';
import { createWorkspaceServers, parseCurlReply, startScript, type ServedServer } from './workspace-servers.js';
import type { RunTicket } from '../temporal/contracts.js';

const where = mkdtempSync(join(tmpdir(), 'workspace-server-'));
const ticket: RunTicket = { runId: 'run-1', depth: 0, ownerId: 'user-1', agentSlug: 'executor' } as RunTicket;
const environment = { id: 'sandbox-1', spec: { kind: 'sandbox', lifecycle: 'invocation' } } as never;

const local: EnvironmentDriver = {
  exec: (request: ExecRequest) => new Promise<ExecResult>((resolve) => {
    const child = spawn('sh', ['-c', request.command], { cwd: where });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    request.signal?.addEventListener('abort', () => child.kill('SIGKILL'));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  }),
} as unknown as EnvironmentDriver;

const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer().listen(0, () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

let port = 0;
let echo: ServedServer;

beforeAll(async () => {
  port = await freePort();
  const source = MCP_SERVER_FILES.find((file) => file.path === 'src/server.js')!.content.replaceAll('{{projectName}}', 'echoes');
  writeFileSync(join(where, 'server.mjs'), source);
  echo = { name: 'echoes', start: `PORT=${port} exec node ${join(where, 'server.mjs')}`, port };
});

afterAll(async () => {
  await local.exec({ command: `pkill -f ${join(where, 'server.mjs')} || true` });
});

const servers = () => createWorkspaceServers({ environments: { forRun: async () => local } });

describe('a server that runs in the workspace', () => {
  it('is started on first use, answers a call through curl in the workspace, and a second call reuses it', async () => {
    const workspace = servers();
    expect(await workspace.call({ ticket, environment, server: echo, tool: 'echo', args: { message: 'hello' } })).toEqual({ ok: true, digest: 'You said: hello', content: 'You said: hello' });
    expect(await workspace.call({ ticket, environment, server: echo, tool: 'echo', args: { message: 'again' } })).toMatchObject({ ok: true, digest: 'You said: again' });
    const running = await local.exec({ command: `pgrep -f "[n]ode ${join(where, 'server.mjs')}" | wc -l` });
    expect(running.stdout.trim()).toBe('1');
  });

  it('says why when its server will not start, with the end of its log', async () => {
    const broken = { name: 'broken', start: 'echo cannot start this; exit 3', port: await freePort() };
    const out = await servers().call({ ticket, environment, server: broken, tool: 'echo', args: {} });
    expect(out.ok).toBe(false);
    expect(out.digest).toContain('broken could not be started in the workspace');
    expect(out.digest).toContain('cannot start this');
  }, 90_000);

  it('says why when the run has no workspace for it', async () => {
    const none = createWorkspaceServers({ environments: { forRun: async () => undefined } });
    expect(await none.call({ ticket, server: echo, tool: 'echo', args: {} })).toMatchObject({ ok: false, digest: 'echoes runs in a workspace, and this run has none' });
  });
});

describe('reading what curl hands back', () => {
  it('skips an interim reply and keeps the headers and body of the real one', () => {
    const reply = parseCurlReply('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: s1\r\n\r\n{"ok":true}');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('mcp-session-id')).toBe('s1');
    expect(reply.body).toBe('{"ok":true}');
  });

  it('starts a server only when nothing answers, and quotes its command', () => {
    const script = startScript('my browser', { start: "run 'it'", port: 8931 });
    expect(script).toContain("setsid nohup sh -c 'run '\\''it'\\''' > /tmp/.koala-servers/my-browser.log");
    expect(script.indexOf('answers && exit 0')).toBeLessThan(script.indexOf('setsid'));
  });
});
