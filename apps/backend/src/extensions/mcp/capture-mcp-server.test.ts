import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_GROUPS,
  HOST_OP_KIND,
  WORKFLOW_IMPLEMENTATIONS,
  type NodeExecutor,
  type NodeImplementation,
  runProcedure,
} from '@koala/agent-engine/procedure';
import type { EnvironmentDriver } from '@koala/engine-core';
import type { McpServerRecord } from '../../lib/mcp-servers.js';
import { runsFingerprint } from '../../lib/mcp-servers.js';
import { platformCatalogue } from '../installed.js';
import { createMcpOperations } from './operations/handlers.js';
import { CAPTURE_MCP_SERVER } from './procedures.js';
import { PLAYWRIGHT } from './templates.js';
import { createRunEnvironments, environmentIdFor } from '../../engine-host/sandboxes/run-environments.js';

const TOOLS = [
  { name: 'browser_navigate', description: 'Open a page.', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'browser_snapshot', description: 'Read the page.', annotations: { readOnlyHint: true } },
];

function answer(body: string): { status: number; body: string } {
  const call = JSON.parse(body) as { id?: number; method: string };
  if (call.method === 'initialize') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'Fake', version: '2' }, instructions: 'Snapshot before you click.' } }) };
  if (call.method === 'tools/list') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { tools: TOOLS } }) };
  return { status: 400, body: '{}' };
}

const hostedFetch = (async (_url: string, init: { body: string }) => {
  const reply = answer(init.body);
  return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as never;

function sandbox(over: { startFails?: string | undefined } = {}): { driver: EnvironmentDriver; commands: string[] } {
  const commands: string[] = [];
  const driver = {
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      if (command.includes('setsid nohup')) return over.startFails ? { stdout: over.startFails, stderr: '', exitCode: 1 } : { stdout: '', stderr: '', exitCode: 0 };
      const sent = command.match(/^printf '%s' '([^']*)'/);
      if (sent) {
        const reply = answer(Buffer.from(sent[1]!, 'base64').toString('utf8'));
        return { stdout: `HTTP/1.1 ${reply.status} OK\r\ncontent-type: application/json\r\n\r\n${reply.body}`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  } as unknown as EnvironmentDriver;
  return { driver, commands };
}

function capture(server: McpServerRecord, over: { buildFails?: string | undefined; startFails?: string | undefined; unreachable?: boolean } = {}) {
  const records = new Map([[server.id, server]]);
  const opened: unknown[] = [];
  const released: string[] = [];
  const { driver, commands } = sandbox(over);
  const operations = createMcpOperations({
    servers: { get: async (_ownerId, id) => records.get(id), save: async (saved) => { records.set(saved.id, saved); } },
    hostedUrl: async (_ownerId, runs) => (over.unreachable ? undefined : 'url' in runs ? runs.url : undefined),
    plan: (runs) => ({ base: 'ubi-node', installs: runs.install, provides: ['node', 'curl'], fingerprint: 'fp' }),
    images: { ensure: async () => { if (over.buildFails) throw new Error(over.buildFails); return 'reg/ws:fp'; } },
    environments: { forRun: async (request) => { opened.push(request.environment); return driver; }, release: async (runId) => { released.push(runId); } },
    fetch: hostedFetch,
    now: () => '2026-10-12T12:00:00Z',
  });
  const local = new Map<string, NodeImplementation>(WORKFLOW_IMPLEMENTATIONS.map((implementation) => [implementation.kind, implementation] as const));
  const executor: NodeExecutor = {
    async step(request) {
      if (request.node.kind === HOST_OP_KIND) return operations[String(request.node.settings.operation)]!(request);
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'step') throw new Error(`no step for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
    async value(request) {
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'value') throw new Error(`no value for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
  };
  const run = () => runProcedure({
    procedure: CAPTURE_MCP_SERVER,
    catalogue: platformCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor,
    identity: { runId: 'mcp-capture-s1', depth: 0, agentId: 'mcp-capture', loopId: 'capture-mcp-server', loopVersion: '1', trigger: 'user' },
    launch: { ownerId: 'u1' },
    inputs: { serverId: server.id },
    bus: { emit: () => undefined, subscribe: () => () => undefined } as never,
  });
  return { run, records, opened, commands, released };
}

const record = (over: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: 's1', ownerId: 'u1', name: 'fake', runs: { where: 'hosted', url: 'http://fake.test/mcp' },
  capturing: { runId: 'mcp-capture-s1', at: '2026-10-12T11:59:00Z' }, createdAt: 't0', updatedAt: 't0', ...over,
});

describe('capturing an MCP server', () => {
  it('asks a hosted server what it says about itself and keeps its instructions and tools', async () => {
    const { run, records } = capture(record());
    expect(await run()).toMatchObject({ outcome: 'ok', outputs: { captured: { result: 'fake serves 2 tools' } } });
    const kept = records.get('s1')!;
    expect(kept.captured).toEqual({ instructions: 'Snapshot before you click.', serverInfo: { name: 'Fake', version: '2' }, tools: TOOLS, at: '2026-10-12T12:00:00Z', fingerprint: runsFingerprint(kept.runs) });
    expect(kept.capturing).toBeUndefined();
  });

  it('keeps why a hosted server could not be reached, and offers it to no one', async () => {
    const { run, records } = capture(record(), { unreachable: true });
    expect(await run()).toMatchObject({ outcome: 'failed' });
    expect(records.get('s1')!.failed).toMatchObject({ why: expect.stringContaining('has no address this server can reach') });
  });

  it('builds a workspace server\'s image, starts it in the run\'s own sandbox in that image, and asks it', async () => {
    const { run, records, opened, commands, released } = capture(record({ name: 'playwright', runs: PLAYWRIGHT.runs }));
    expect(await run()).toMatchObject({ outcome: 'ok', outputs: { capturedStarted: { result: 'playwright serves 2 tools' } } });
    expect(opened).toEqual([expect.objectContaining({ id: environmentIdFor('mcp-capture-s1'), spec: { kind: 'sandbox', lifecycle: 'invocation' }, workspace: expect.objectContaining({ image: 'reg/ws:fp', runId: 'mcp-capture-s1' }) })]);
    expect(commands[0]).toContain('playwright-mcp --browser chromium');
    expect(records.get('s1')!.captured!.tools.map((tool) => tool.name)).toEqual(['browser_navigate', 'browser_snapshot']);
    expect(released).toEqual(['mcp-capture-s1']);
  });

  it('keeps why the image did not build or the server did not start, with what it printed', async () => {
    const built = capture(record({ runs: PLAYWRIGHT.runs }), { buildFails: 'No match for argument: nss' });
    expect(await built.run()).toMatchObject({ outcome: 'failed' });
    expect(built.records.get('s1')!.failed!.why).toBe('its image did not build: No match for argument: nss');
    expect(built.opened).toEqual([]);

    const started = capture(record({ runs: PLAYWRIGHT.runs }), { startFails: 'nothing answered on port 8931; the end of its log:\nError: Cannot find module' });
    expect(await started.run()).toMatchObject({ outcome: 'failed' });
    expect(started.records.get('s1')!.failed!.why).toContain('Cannot find module');
    expect(started.released).toEqual(['mcp-capture-s1']);
  });

  it('leaves a capture started after it alone, and records nothing for a server removed meanwhile', async () => {
    const later = capture(record({ capturing: { runId: 'mcp-capture-later', at: '2026-10-12T12:00:30Z' } }));
    await later.run();
    expect(later.records.get('s1')!.capturing).toEqual({ runId: 'mcp-capture-later', at: '2026-10-12T12:00:30Z' });
    expect(later.records.get('s1')!.captured).toBeDefined();

    const gone = capture(record());
    gone.records.clear();
    expect(await gone.run()).toMatchObject({ outcome: 'failed', reason: 'there is no server "s1"' });
  });
});

describe('the capture\'s sandbox', () => {
  it('is one the run\'s own release lets go of', async () => {
    const disposed: string[] = [];
    const environments = createRunEnvironments({ provision: async ({ id }) => ({ dispose: async () => { disposed.push(id); } }) as never });
    const ticket = { runId: 'mcp-capture-s1', depth: 0, ownerId: 'u1', agentSlug: 'mcp-capture', trigger: 'user' as const };
    await environments.forRun({ ticket, id: environmentIdFor(ticket.runId), spec: { kind: 'sandbox', lifecycle: 'invocation' } });
    expect(await environments.release(ticket.runId)).toBe(true);
    expect(disposed).toEqual([environmentIdFor('mcp-capture-s1')]);
  });
});
