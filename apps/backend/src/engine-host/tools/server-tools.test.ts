import { describe, expect, it } from 'vitest';
import { createServerTools } from './server-tools.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from '../../engine/lib/mcp-servers.js';
import type { RunTicket } from '../temporal/contracts.js';

const ticket: RunTicket = { runId: 'run-1', depth: 0, ownerId: 'u1', agentSlug: 'executor', trigger: 'user', conversationId: 'c1' };
const sandbox = { id: 'sandbox-1', spec: { kind: 'sandbox', lifecycle: 'invocation' } } as never;

const WORKSPACE: ServerRuns = { where: 'workspace', needs: ['playwright-mcp'], start: 'playwright-mcp --port 8931', port: 8931 };
const HOSTED: ServerRuns = { where: 'hosted', url: 'http://docs.test/mcp' };

const server = (name: string, runs: ServerRuns, over: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: name, ownerId: 'u1', name, runs, createdAt: 't0', updatedAt: 't0',
  captured: {
    instructions: `${name} says hello.`,
    tools: [
      { name: 'browser_snapshot', description: 'Read the page.', annotations: { readOnlyHint: true } },
      { name: 'browser_click', description: 'Click.' },
      { name: 'browser_take_screenshot', description: 'Take a picture.' },
    ],
    at: 't1',
    fingerprint: runsFingerprint(runs),
  },
  ...over,
});

function source(catalogue: McpServerRecord[], enabled: string[] = []) {
  const calls: unknown[] = [];
  const tools = createServerTools({
    catalogue: async () => catalogue,
    enabled: async () => enabled,
    hosted: { call: async (_ownerId, runs, tool, args) => { calls.push({ runs, tool, args }); return { text: `hosted ${tool}`, isError: false }; } },
    workspace: { call: async ({ server, tool, args }) => { calls.push({ server, tool, args }); return { ok: true, digest: `workspace ${tool}`, content: `workspace ${tool}` }; } },
  });
  return { tools, calls };
}

describe('the tools of the MCP servers a run holds', () => {
  it('are offered from the record, under the server\'s name, with what it and the person say about it', async () => {
    const { tools } = source([server('playwright', WORKSPACE, {
      summary: 'A headless browser.', notes: 'Odoo is on 8069.', dependsOn: 'the kept Odoo', omit: ['browser_take_screenshot'],
      tools: { browser_click: { note: 'Click by ref.', kind: 'safe-write' } },
    })]);
    const offered = await tools.forRun({ ticket, environment: sandbox, held: ['playwright'] });
    expect(offered.withheld).toEqual([]);
    expect(offered.tools).toEqual([
      expect.objectContaining({ name: 'playwright__browser_snapshot', binding: 'environment', effect: 'read', description: 'Read the page.', servedBy: { server: 'playwright', where: 'workspace', summary: 'A headless browser.', instructions: 'playwright says hello.', notes: 'Odoo is on 8069.', dependsOn: 'the kept Odoo' } }),
      expect.objectContaining({ name: 'playwright__browser_click', effect: 'write', destructive: false, usageGuidance: 'Click by ref.' }),
    ]);
  });

  it('calls a workspace server in the run\'s workspace and a hosted one at its address', async () => {
    const { tools, calls } = source([server('playwright', WORKSPACE), server('docs', HOSTED)]);
    const offered = await tools.forRun({ ticket, environment: sandbox, held: ['playwright', 'docs'] });
    expect(await offered.handlers['playwright__browser_snapshot']!({ name: 'playwright__browser_snapshot', parsed: {}, caller: {} } as never)).toMatchObject({ ok: true, digest: 'workspace browser_snapshot' });
    expect(await offered.handlers['docs__browser_click']!({ name: 'docs__browser_click', parsed: { ref: 'e1' }, caller: {} } as never)).toMatchObject({ ok: true, digest: 'hosted browser_click' });
    expect(calls).toEqual([
      { server: { name: 'playwright', start: 'playwright-mcp --port 8931', port: 8931, path: '/mcp' }, tool: 'browser_snapshot', args: {} },
      { runs: HOSTED, tool: 'browser_click', args: { ref: 'e1' } },
    ]);
  });

  it('withholds a server it cannot use, saying why, and the tools an agent may not use', async () => {
    const { tools } = source([
      server('fresh', HOSTED, { captured: undefined }),
      server('broken', HOSTED, { failed: { at: 't2', why: 'it did not answer', fingerprint: runsFingerprint(HOSTED) } }),
      server('busy', HOSTED, { captured: undefined, capturing: { runId: 'r', at: 't' } }),
      server('playwright', WORKSPACE),
    ]);
    const offered = await tools.forRun({ ticket, held: ['fresh', 'broken', 'busy', 'playwright', 'gone'], ceiling: 'read' });
    expect(offered.tools).toEqual([]);
    expect(offered.withheld).toEqual([
      { name: 'fresh', why: 'it has not been captured yet, so nothing knows which tools it serves' },
      { name: 'broken', why: 'its last capture failed, so it is offered to no one: it did not answer' },
      { name: 'busy', why: 'it is being captured; its tools are offered once that finishes' },
      { name: 'playwright', why: 'it runs in a workspace, and this run has none' },
      { name: 'gone', why: 'there is no MCP server by that name in the catalogue' },
    ]);
    const limited = await tools.forRun({ ticket, environment: sandbox, held: ['playwright'], ceiling: 'read' });
    expect(limited.tools.map((tool) => tool.name)).toEqual(['playwright__browser_snapshot']);
    expect(limited.withheld.map((tool) => tool.name)).toEqual(['playwright__browser_click', 'playwright__browser_take_screenshot']);
  });

  it('adds the servers switched on in the conversation to those the agent holds', async () => {
    const { tools } = source([server('docs', HOSTED)], ['docs']);
    expect((await tools.forRun({ ticket, held: [] })).tools.map((tool) => tool.name)).toContain('docs__browser_snapshot');
    expect((await source([server('docs', HOSTED)], ['docs']).tools.forRun({ ticket: { ...ticket, conversationId: undefined }, held: [] })).tools).toEqual([]);
  });
});
