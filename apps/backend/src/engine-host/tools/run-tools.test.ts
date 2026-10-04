import { describe, it, expect } from 'vitest';
import type { ToolHandlerContext } from '@koala/engine-core';
import type { StoredNodeTrace } from '../../lib/run-traces.js';
import { createRunTools } from './run-tools.js';
import { RUN_TOOLS } from './run-tools-catalogue.js';

const trace = (sequence: number, node: string, kind: string, over: Partial<StoredNodeTrace> = {}): StoredNodeTrace => ({
  sequence, step: sequence, node, origin: node, kind, role: 'step', cleanup: false, startedAt: 0, durationMs: 1,
  inputs: {}, runId: 'run-exec', ownerId: 'user-1', agentSlug: 'executor', procedureId: 'tool-rounds', procedureVersion: '2', ...over,
});

const TRACES = [
  trace(1, 'turn', 'call-model', { exit: 'tools', outputs: { content: '', toolCalls: [{ name: 'run_command', arguments: '{"command":"npm test"}' }] } }),
  trace(2, 'tools', 'run-tools', { exit: 'ran', outputs: { results: [{ name: 'run_command', content: `npm ERR! missing script: test\n${'x'.repeat(2000)}` }] } }),
  trace(3, 'turn', 'call-model', { error: 'the model could not be reached' }),
  trace(4, 'failed', 'finish', { finish: { outcome: 'failed', reason: '"turn" failed: the model could not be reached' } }),
];

const tools = createRunTools({
  runs: { traces: async (ownerId, runId) => (ownerId === 'user-1' && runId === 'run-exec' ? [...TRACES].reverse() : []) },
});

const call = (parsed: Record<string, unknown>, ownerId = 'user-1') =>
  tools.read_run!({ name: 'read_run', parsed, driver: undefined, caller: { ownerId, agentSlug: 'leaf-judge' } } as ToolHandlerContext);

describe('read_run', () => {
  it('gives the whole run in order, one line per step: what ran, how it ended, and what it produced', async () => {
    const out = await call({ runId: 'run-exec' });

    expect(out.ok).toBe(true);
    const lines = out.content!.split('\n');
    expect(lines[0]).toBe('run run-exec — agent executor, procedure tool-rounds@2, 4 steps');
    expect(out.content).toContain('#1 turn (call-model) → tools');
    expect(out.content).toContain('#2 tools (run-tools) → ran');
    expect(out.content).toContain('npm ERR! missing script: test');
    expect(out.content).toContain('#3 turn (call-model) error: the model could not be reached');
    expect(out.content).toContain('#4 failed (finish) finished failed: "turn" failed: the model could not be reached');
  });

  it('reads one step in full when asked, so nothing the overview shortened is out of reach', async () => {
    const out = await call({ runId: 'run-exec', node: 'tools' });

    expect(out.ok).toBe(true);
    expect(out.content).toContain('x'.repeat(2000));
    expect((await call({ runId: 'run-exec', node: 'turn#3' })).content).toContain('error: the model could not be reached');
    expect((await call({ runId: 'run-exec', node: 'turn#3' })).content).not.toContain('#1 turn');
  });

  it('names the steps a run has when asked for one it does not', async () => {
    const out = await call({ runId: 'run-exec', node: 'nowhere' });
    expect(out).toMatchObject({ ok: false, content: 'run run-exec has no node "nowhere"; it has turn, tools, failed' });
  });

  it('reads only the person\'s own runs', async () => {
    expect(await call({ runId: 'run-exec' }, 'someone-else')).toMatchObject({ ok: false, content: 'there is no run run-exec of yours that recorded anything' });
    expect(await call({})).toMatchObject({ ok: false });
  });

  it('is declared read-only, so any agent can be given it', () => {
    expect(RUN_TOOLS.map((tool) => [tool.name, tool.effect, tool.idempotent])).toEqual([['read_run', 'read', true]]);
  });
});
