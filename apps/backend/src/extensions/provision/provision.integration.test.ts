import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowHandle } from '@temporalio/client';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import { ownerIn, startedFor } from '../../platform/lib/workflow-owner.js';
import { againPieces, openedRecord, provisionPieceWorkflowId, provisionRunId, type ProvisioningRecord, type ProvisionPieceInput, type ProvisionRunInput } from '../../infrastructure/lib/provisioning.js';
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
  const runOn = async (say: string, store = new MemoryInfrastructureStore(), carried?: ProvisioningRecord['pieces']) => {
    const order: string[] = [];
    const operations = createProvisionOperations({
      records: store,
      pieces: { run: async (piece, signal) => { order.push(piece.piece); return pieces().run(piece, signal); } },
    });
    const reason = carried ? 'asked' : 'revision';
    const inputs: ProvisionRunInput = { ownerId: 'bo', recordId: provisionRunId(`${WORLD}-own`, say), target: { kind: 'koala', clusterId: `${WORLD}-own` }, revision: 3, reason };
    await store.openProvisioning(openedRecord({ ownerId: 'bo', target: inputs.target, revision: 3, reason, runId: inputs.recordId, at: new Date().toISOString(), pieces: carried }));
    const result = await runOnHost({ procedure: PROVISION, operations, runId: inputs.recordId, agentId: PROVISION_AGENT, ownerId: 'bo', inputs });
    return { result, order, store, record: (await store.getProvisioningRun(inputs.recordId))! };
  };

  const NOT_UP = 'Gitea, your repositories and images: pod gitea-0 is Init:Error: the volume is full; Infisical, your secrets: the chart infisical-standalone 1.12.0 could not be read';
  const everyPiece = PROVISION_PIECES.map((piece) => piece.key).sort();

  it('set up again after it stopped, sets up only the pieces that are not up, leaving the pieces already up untouched', async () => {
    const stopped = await runOn('refused-first~refused+broken');
    const again = await runOn('again', stopped.store, againPieces(stopped.record, stopped.record.target, 3));
    expect(again.result.outcome).toBe('ok');
    expect(again.order.sort()).toEqual(['gitea', 'infisical']);
    expect(again.record.state).toBe('up');
    const wereUp = (pieces: ProvisioningRecord['pieces']) => pieces.filter((piece) => piece.key !== 'gitea' && piece.key !== 'infisical');
    expect(wereUp(again.record.pieces)).toEqual(wereUp(stopped.record.pieces));
    await expect(fixture.env.client.workflow.getHandle(provisionPieceWorkflowId(again.record.runId, 'egress')).describe()).rejects.toThrow();
  });

  it('sets up every piece and ends up', async () => {
    const { result, order, record } = await runOn('all');
    expect(result.outcome).toBe('ok');
    expect(order.sort()).toEqual(everyPiece);
    expect(record.state).toBe('up');
  });

  it('sets up every other piece when some can never come up, then ends failed naming each piece that did not and why', async () => {
    const { result, order, record } = await runOn('refused+broken');
    expect(result).toMatchObject({ outcome: 'failed', reason: NOT_UP });
    expect(order.sort()).toEqual(everyPiece);
    expect(record).toMatchObject({ state: 'failed', why: NOT_UP });
    expect(record.pieces.filter((piece) => piece.state !== 'up').map((piece) => [piece.key, piece.state])).toEqual([['gitea', 'failed'], ['infisical', 'failed']]);
    expect((await fixture.env.client.workflow.getHandle(provisionPieceWorkflowId(record.runId, 'verdaccio')).describe()).status.name).toBe('COMPLETED');
  });
});
