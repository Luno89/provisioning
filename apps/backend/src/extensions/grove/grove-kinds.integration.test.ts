import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporalTestEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { GroveWorld } from './testing/grove-world.js';
import type { Procedure } from '@koala/agent-engine/procedure';
import { seededAgents, seededProcedures } from '../seeds.js';

let env: TestWorkflowEnvironment;
let grove: GroveWorld;

beforeAll(async () => {
  env = await temporalTestEnvironment();
  grove = new GroveWorld(env);
});

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => grove.reset());

describe('the grove agent\'s procedure, on other kinds of work', () => {
  it('puts aside a leaf whose tasks wait for the workspace — not failed, not planned again — and leaves what depends on it waiting', async () => {
    const { result, worktreeOfCall } = await grove.run({ agent: 'grove', waitingTasksOf: 'leafA' });

    const leafA = grove.leafOf('leafA')!;
    expect(leafA).toMatchObject({ status: 'pending', waitingFor: { reason: '"Build the /health endpoint" waits for the workspace to get dnf wkhtmltopdf' } });
    expect(leafA.claim).toBeUndefined();
    expect(leafA.attempts ?? []).toEqual([]);
    expect(worktreeOfCall.filter((call) => call.startsWith('executor') && call.includes('leafA'))).toEqual([]);
    expect(grove.plans.map((plan) => plan.leafPlan?.leafId)).not.toContain('leafA');
    expect(grove.leafOf('leafB')).toMatchObject({ status: 'succeeded' });
    expect(result).toMatchObject({ outcome: 'quiet' });
  });

  it('honours a limit set on a copy of the procedure: no replans means a failed leaf is left for the person', async () => {
    grove.judgeVerdicts = { leafB: 'failed' };
    const careful: Procedure = { ...seededProcedures().find((procedure) => procedure.id === 'grove-run')!, id: 'grove-run-careful' };
    careful.nodes = careful.nodes.map((node) => (node.id === 'needs' ? { ...node, settings: { ...node.settings, replans: 0 } } : node));
    const seededGrove = seededAgents().find((persona) => persona.slug === 'grove')!;

    const { result } = await grove.run({ agent: 'grove-careful', ownProcedures: [careful], ownAgents: [{ ...seededGrove, slug: 'grove-careful', procedure: 'grove-run-careful' }] });

    expect(grove.leafOf('leafB')).toMatchObject({ status: 'failed' });
    expect(grove.plans).toEqual([]);
    expect(result).toMatchObject({ outcome: 'quiet', awaitingApproval: [] });
  });

  it('claims a paper leaf whose writer failed, saying the work stopped and why, so its judge decides', async () => {
    grove.trees = grove.trees.map((tree) => ({ ...tree, type: 'research-paper' }));
    grove.writerFails = 'leafA';
    grove.judgeVerdicts = { leafA: 'failed' };

    const { worktreeOfCall } = await grove.run({ agent: 'grove-paper', vanishTasksOf: 'leafA' });

    const leafA = grove.leafOf('leafA')!;
    expect(leafA.claim?.evidence ?? '').toMatch(/stopped: the work did not finish: .*stopped answering mid-paper/);
    expect(worktreeOfCall.some((call) => call.startsWith('leaf-judge settle_leaf') && call.includes('leafA'))).toBe(true);
    expect(leafA.status).toBe('failed');
  });

  it('has the paper writer write each leaf in one run, and the claim carries what it said', async () => {
    grove.trees = grove.trees.map((tree) => ({ ...tree, type: 'research-paper' }));

    const { result, worktreeOfCall } = await grove.run({ agent: 'grove-paper', vanishTasksOf: 'leafA' });

    expect(result).toMatchObject({ treeId: 'tree-1', outcome: 'quiet' });
    expect(grove.leaves.every((leaf) => leaf.status === 'succeeded'), JSON.stringify(grove.leaves.map((leaf) => [leaf.id, leaf.status]))).toBe(true);
    expect(worktreeOfCall.filter((call) => call.startsWith('executor'))).toEqual([]);
    expect(grove.leafOf('leafA')?.claim?.evidence ?? '').toContain('Wrote paper.md for leafA');
  });
});
