import { describe, expect, it } from 'vitest';
import { BUILT_IN_GROUPS, HOST_OP_KIND, WORKFLOW_IMPLEMENTATIONS, runProcedure, type NodeExecutor, type NodeImplementation } from '@koala/agent-engine/procedure';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import type { ProvisionPieceInput, ProvisionPieceResult, ProvisioningRecord, ProvisionRunInput } from '../../infrastructure/lib/provisioning.js';
import { INSTALLED_EXTENSIONS, platformCatalogue } from '../installed.js';
import { createProvisionOperations } from './operations/handlers.js';
import { PROVISION } from './procedures.js';
import { PROVISION_AGENT, PROVISION_PROCEDURE } from './names.js';

const AT = '2026-11-18T12:00:00.000Z';
const OWN: ProvisionRunInput = { ownerId: 'bo', recordId: 'provision-machine-desk~1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 7, reason: 'revision' };
const SECOND: ProvisionRunInput = { ownerId: 'bo', recordId: 'provision-machine-desk2~1', target: { kind: 'machine', clusterId: 'machine-desk2', machine: 'desk-2' }, revision: 7, reason: 'missing' };

function world(answers: Partial<Record<string, ProvisionPieceResult>> = {}) {
  const records = new Map<string, ProvisioningRecord>();
  const started: ProvisionPieceInput[] = [];
  const operations = createProvisionOperations({
    records: { get: async (id) => records.get(id), save: async (record) => { records.set(record.id, record); } },
    pieces: { run: async (piece) => { started.push(piece); return answers[piece.piece] ?? { ok: true }; } },
    now: () => AT,
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
  const run = (inputs: ProvisionRunInput) => runProcedure({
    procedure: PROVISION,
    catalogue: platformCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor,
    identity: { runId: inputs.recordId, depth: 0, agentId: PROVISION_AGENT, loopId: PROVISION.id, loopVersion: '1', trigger: 'user' },
    launch: { ownerId: inputs.ownerId },
    inputs: inputs as unknown as Record<string, unknown>,
    bus: { emit: () => undefined, subscribe: () => () => undefined } as never,
  });
  return { run, started, records };
}

describe('the provision procedure', () => {
  it('is the procedure the provision persona runs, and both ship in the provision extension', () => {
    const extension = INSTALLED_EXTENSIONS.find((entry) => entry.id === 'provision')!;
    expect(PROVISION.id).toBe(PROVISION_PROCEDURE);
    expect(extension.procedures?.map((procedure) => procedure.id)).toEqual([PROVISION_PROCEDURE]);
    expect(extension.personas?.find((persona) => persona.slug === PROVISION_AGENT)?.procedure).toBe(PROVISION_PROCEDURE);
  });

  it('sets up every piece of the Koala\'s own cluster in order, then marks the setup up', async () => {
    const { run, started, records } = world();
    const result = await run(OWN);
    expect(result.outcome).toBe('ok');
    expect(started.map((piece) => piece.piece)).toEqual(PROVISION_PIECES.map((piece) => piece.key));
    expect(started.every((piece) => piece.recordId === OWN.recordId && piece.revision === 7)).toBe(true);
    const record = records.get(OWN.recordId)!;
    expect(record.state).toBe('up');
    expect(record.pieces.every((piece) => piece.state === 'up')).toBe(true);
  });

  it('stops at the first piece that can never come up, sets up nothing after it, and ends failed with its why', async () => {
    const { run, started, records } = world({ gitea: { ok: false, why: 'pod gitea-0 is Init:Error: the volume is full' } });
    const result = await run(OWN);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('pod gitea-0 is Init:Error: the volume is full');
    expect(started.map((piece) => piece.piece)).toEqual(['egress', 'searxng', 'crawl4ai', 'gitea']);
    const record = records.get(OWN.recordId)!;
    expect(record).toMatchObject({ state: 'failed', why: 'Gitea, your repositories and images: pod gitea-0 is Init:Error: the volume is full' });
    expect(record.pieces.filter((piece) => piece.state === 'waiting').map((piece) => piece.key)).toEqual(['verdaccio', 'infisical', 'monitoring']);
  });

  it('ends failed with monitoring\'s why when the last piece cannot come up', async () => {
    const { run, records } = world({ monitoring: { ok: false, why: 'the CRDs never came up' } });
    const result = await run(OWN);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'the CRDs never came up' });
    expect(records.get(OWN.recordId)).toMatchObject({ state: 'failed', why: 'Monitoring: the CRDs never came up' });
  });

  it('sets up only the collector on another of the person\'s machines', async () => {
    const { run, started, records } = world();
    const result = await run(SECOND);
    expect(result.outcome).toBe('ok');
    expect(started.map((piece) => [piece.piece, piece.target])).toEqual([['monitoring', SECOND.target]]);
    expect(records.get(SECOND.recordId)).toMatchObject({ state: 'up', pieces: [{ key: 'monitoring', state: 'up' }] });
  });

  it('ends failed without touching anything when the run\'s record is someone else\'s', async () => {
    const { run, started, records } = world();
    records.set(OWN.recordId, { id: OWN.recordId, runId: OWN.recordId, ownerId: 'someone', target: OWN.target, revision: 7, reason: 'revision', state: 'running', pieces: [], startedAt: AT });
    const result = await run(OWN);
    expect(result).toMatchObject({ outcome: 'failed', reason: `the setup ${OWN.recordId} is not bo's` });
    expect(started).toEqual([]);
  });
});
