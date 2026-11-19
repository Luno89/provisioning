import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowHandle } from '@temporalio/client';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import { ownerIn, startedFor } from '../../platform/lib/workflow-owner.js';
import { openedRecord, provisionPieceWorkflowId, provisionRunId, type ProvisionPieceInput, type ProvisionRunInput } from '../../infrastructure/lib/provisioning.js';
import { MemoryInfrastructureStore } from '../../infrastructure/testing/memory-store.js';
import { fixtureWorker, type FixtureWorker } from '../testing/fixture-worker.js';
import { runOnHost } from '../testing/host-op-runs.js';
import { createProvisionOperations } from './operations/handlers.js';
import { provisionPiecesOn } from './pieces.js';
import { PROVISION } from './procedures.js';
import { PROVISION_AGENT, PROVISION_PIECE_WORKFLOW } from './names.js';

const WORLD = `provision-${randomUUID().slice(0, 8)}`;
const QUEUE = `${WORLD}-cluster`;
let fixture: FixtureWorker;

beforeAll(async () => {
  fixture = await fixtureWorker(QUEUE, resolve(__dirname, 'testing/piece.fixture-workflow.ts'));
});

afterAll(async () => {
  await fixture?.stop();
});

const pieces = () => provisionPiecesOn({ client: async () => fixture.env.client, queue: QUEUE });

const pieceFor = (say: string, piece: ProvisionPieceInput['piece'] = 'gitea'): ProvisionPieceInput => ({
  ownerId: 'bo', recordId: provisionRunId(`${WORLD}-desk`, say), target: { kind: 'koala', clusterId: `${WORLD}-desk` }, revision: 7, piece,
});

const stoppedWhileHeld = async (piece: ProvisionPieceInput, handle: Pick<WorkflowHandle, 'describe'>) => {
  const stop = new AbortController();
  const ending = pieces().run(piece, stop.signal);
  stop.abort('the run was stopped');
  expect(await ending).toEqual({ ok: false, why: 'the run was stopped' });
  expect((await handle.describe()).status.name).toBe('CANCELLED');
};

describe('a piece of a setup, run on the cluster queue', () => {
  it('starts the piece\'s workflow by name on the queue it is given, as the person\'s own work, and hands back that the piece is up', async () => {
    const piece = pieceFor('up');
    expect(await pieces().run(piece)).toEqual({ ok: true });
    const described = await fixture.env.client.workflow.getHandle(provisionPieceWorkflowId(piece.recordId, 'gitea')).describe();
    expect(described.type).toBe(PROVISION_PIECE_WORKFLOW);
    expect(described.taskQueue).toBe(QUEUE);
    expect(ownerIn(described.typedSearchAttributes)).toBe('bo');
  });

  it('hands back the piece\'s own why when it can never come up, and the workflow\'s failure when the workflow itself failed', async () => {
    expect(await pieces().run(pieceFor('refused'))).toEqual({ ok: false, why: 'pod gitea-0 is Init:Error: the volume is full' });
    expect(await pieces().run(pieceFor('broken', 'infisical'))).toEqual({ ok: false, why: 'the chart infisical-standalone 1.12.0 could not be read' });
  });

  it('refuses an answer that is not a piece\'s result rather than reading it as up', async () => {
    await expect(pieces().run(pieceFor('garbled'))).rejects.toThrow(/not what a piece answers/);
  });

  it('cancels the piece\'s workflow when the run is stopped, and hands back that it was stopped', async () => {
    const piece = pieceFor('held');
    await stoppedWhileHeld(piece, fixture.env.client.workflow.getHandle(provisionPieceWorkflowId(piece.recordId, 'gitea')));
  });

  it('follows the piece already under way when it is asked again, rather than starting a second', async () => {
    const piece = pieceFor('held-again');
    const handle = await fixture.env.client.workflow.start(PROVISION_PIECE_WORKFLOW, { taskQueue: QUEUE, workflowId: provisionPieceWorkflowId(piece.recordId, 'gitea'), args: [{ ...piece, recordId: `${piece.recordId}-x~held` }], ...startedFor('bo') });
    await stoppedWhileHeld(piece, handle);
  });
});

describe('the provision procedure, its pieces on real Temporal', () => {
  const runOn = async (say: string) => {
    const store = new MemoryInfrastructureStore();
    const order: string[] = [];
    const operations = createProvisionOperations({
      records: store,
      pieces: { run: async (piece, signal) => { order.push(piece.piece); return pieces().run(piece, signal); } },
    });
    const inputs: ProvisionRunInput = { ownerId: 'bo', recordId: provisionRunId(`${WORLD}-own`, say), target: { kind: 'koala', clusterId: `${WORLD}-own` }, revision: 3, reason: 'revision' };
    await store.openProvisioning(openedRecord({ ownerId: 'bo', target: inputs.target, revision: 3, reason: 'revision', runId: inputs.recordId, at: new Date().toISOString() }));
    const result = await runOnHost({ procedure: PROVISION, operations, runId: inputs.recordId, agentId: PROVISION_AGENT, ownerId: 'bo', inputs });
    return { result, order, record: (await store.getProvisioningRun(inputs.recordId))! };
  };

  it('sets up every piece in order and ends up', async () => {
    const { result, order, record } = await runOn('all');
    expect(result.outcome).toBe('ok');
    expect(order).toEqual(PROVISION_PIECES.map((piece) => piece.key));
    expect(record.state).toBe('up');
  });

  it('ends failed at the first piece that can never come up, with its why, starting nothing after it', async () => {
    const { result, order, record } = await runOn('refused');
    expect(result).toMatchObject({ outcome: 'failed', reason: 'pod gitea-0 is Init:Error: the volume is full' });
    expect(order).toEqual(['egress', 'searxng', 'crawl4ai', 'gitea']);
    expect(record).toMatchObject({ state: 'failed', why: 'Gitea, your repositories and images: pod gitea-0 is Init:Error: the volume is full' });
    await expect(fixture.env.client.workflow.getHandle(provisionPieceWorkflowId(record.runId, 'verdaccio')).describe()).rejects.toThrow();
  });
});
