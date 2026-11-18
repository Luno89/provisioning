import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { BUILT_IN_GROUPS, HOST_OP_KIND, WORKFLOW_IMPLEMENTATIONS, runProcedure, type NodeExecutor, type NodeImplementation } from '@koala/agent-engine/procedure';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import { bundled, realTemporalEnvironment } from '../../workflows/temporal-test-env.js';
import { ownerIn, startedFor } from '../../platform/lib/workflow-owner.js';
import { provisionPieceWorkflowId, provisionRunId, type ProvisionPieceInput, type ProvisioningRecord, type ProvisionRunInput } from '../../infrastructure/lib/provisioning.js';
import { platformCatalogue } from '../installed.js';
import { createProvisionOperations } from './operations/handlers.js';
import { provisionPiecesOn } from './pieces.js';
import { PROVISION } from './procedures.js';
import { PROVISION_AGENT, PROVISION_PIECE_WORKFLOW } from './names.js';

const WORLD = `provision-${randomUUID().slice(0, 8)}`;
const QUEUE = `${WORLD}-cluster`;
let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;

beforeAll(async () => {
  env = await realTemporalEnvironment();
  worker = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue: QUEUE, workflowBundle: await bundled(resolve(__dirname, 'testing/piece.fixture-workflow.ts')) });
  running = worker.run();
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
}, 60_000);

const pieces = () => provisionPiecesOn({ client: async () => env.client, queue: QUEUE });

const pieceFor = (say: string, piece: ProvisionPieceInput['piece'] = 'gitea'): ProvisionPieceInput => ({
  ownerId: 'bo', recordId: provisionRunId(`${WORLD}-desk`, say), target: { kind: 'koala', clusterId: `${WORLD}-desk` }, revision: 7, piece,
});

describe('a piece of a setup, run on the cluster queue', () => {
  it('starts the piece\'s workflow by name on the queue it is given, as the person\'s own work, and hands back that the piece is up', async () => {
    const piece = pieceFor('up');
    expect(await pieces().run(piece)).toEqual({ ok: true });
    const described = await env.client.workflow.getHandle(provisionPieceWorkflowId(piece.recordId, 'gitea')).describe();
    expect(described.type).toBe(PROVISION_PIECE_WORKFLOW);
    expect(described.taskQueue).toBe(QUEUE);
    expect(ownerIn(described.typedSearchAttributes)).toBe('bo');
  }, 60_000);

  it('hands back the piece\'s own why when it can never come up, and the workflow\'s failure when the workflow itself failed', async () => {
    expect(await pieces().run(pieceFor('refused'))).toEqual({ ok: false, why: 'pod gitea-0 is Init:Error: the volume is full' });
    expect(await pieces().run(pieceFor('broken', 'infisical'))).toEqual({ ok: false, why: 'the chart infisical-standalone 1.12.0 could not be read' });
  }, 60_000);

  it('refuses an answer that is not a piece\'s result rather than reading it as up', async () => {
    await expect(pieces().run(pieceFor('garbled'))).rejects.toThrow(/not what a piece answers/);
  }, 60_000);

  it('cancels the piece\'s workflow when the run is stopped, and hands back that it was stopped', async () => {
    const piece = pieceFor('held');
    const stop = new AbortController();
    const ending = pieces().run(piece, stop.signal);
    const handle = env.client.workflow.getHandle(provisionPieceWorkflowId(piece.recordId, 'gitea'));
    stop.abort('the run was stopped');
    expect(await ending).toEqual({ ok: false, why: 'the run was stopped' });
    expect((await handle.describe()).status.name).toBe('CANCELLED');
  }, 60_000);

  it('follows the piece already under way when it is asked again, rather than starting a second', async () => {
    const piece = pieceFor('held-again');
    const handle = await env.client.workflow.start(PROVISION_PIECE_WORKFLOW, { taskQueue: QUEUE, workflowId: provisionPieceWorkflowId(piece.recordId, 'gitea'), args: [{ ...piece, recordId: `${piece.recordId}-x~held` }], ...startedFor('bo') });
    const stop = new AbortController();
    const ending = pieces().run(piece, stop.signal);
    stop.abort('the run was stopped');
    expect(await ending).toEqual({ ok: false, why: 'the run was stopped' });
    expect((await handle.describe()).status.name).toBe('CANCELLED');
  }, 60_000);
});

describe('the provision procedure, its pieces on real Temporal', () => {
  const runOn = async (say: string) => {
    const records = new Map<string, ProvisioningRecord>();
    const order: string[] = [];
    const operations = createProvisionOperations({
      records: { get: async (id) => records.get(id), save: async (record) => { records.set(record.id, record); } },
      pieces: { run: async (piece, signal) => { order.push(piece.piece); return pieces().run(piece, signal); } },
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
    const inputs: ProvisionRunInput = { ownerId: 'bo', recordId: provisionRunId(`${WORLD}-own`, say), target: { kind: 'koala', clusterId: `${WORLD}-own` }, revision: 3, reason: 'revision' };
    const result = await runProcedure({
      procedure: PROVISION,
      catalogue: platformCatalogue(),
      groups: BUILT_IN_GROUPS,
      executor,
      identity: { runId: inputs.recordId, depth: 0, agentId: PROVISION_AGENT, loopId: PROVISION.id, loopVersion: '1', trigger: 'user' },
      launch: { ownerId: 'bo' },
      inputs: inputs as unknown as Record<string, unknown>,
      bus: { emit: () => undefined, subscribe: () => () => undefined } as never,
    });
    return { result, order, record: records.get(inputs.recordId)! };
  };

  it('sets up every piece in order and ends up', async () => {
    const { result, order, record } = await runOn('all');
    expect(result.outcome).toBe('ok');
    expect(order).toEqual(PROVISION_PIECES.map((piece) => piece.key));
    expect(record.state).toBe('up');
  }, 120_000);

  it('ends failed at the first piece that can never come up, with its why, starting nothing after it', async () => {
    const { result, order, record } = await runOn('refused');
    expect(result).toMatchObject({ outcome: 'failed', reason: 'pod gitea-0 is Init:Error: the volume is full' });
    expect(order).toEqual(['egress', 'searxng', 'crawl4ai', 'gitea']);
    expect(record).toMatchObject({ state: 'failed', why: 'Gitea, your repositories and images: pod gitea-0 is Init:Error: the volume is full' });
    await expect(env.client.workflow.getHandle(provisionPieceWorkflowId(record.runId, 'verdaccio')).describe()).rejects.toThrow();
  }, 120_000);
});
