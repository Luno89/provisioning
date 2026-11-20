import { describe, expect, it } from 'vitest';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import { openedRecord, type ProvisionPieceInput, type ProvisionPieceResult, type ProvisionRunInput } from '../../infrastructure/lib/provisioning.js';
import { MemoryInfrastructureStore } from '../../infrastructure/testing/memory-store.js';
import { INSTALLED_EXTENSIONS } from '../installed.js';
import { runOnHost } from '../testing/host-op-runs.js';
import { createProvisionOperations } from './operations/handlers.js';
import { PROVISION } from './procedures.js';
import { PROVISION_AGENT, PROVISION_PROCEDURE } from './names.js';

const AT = '2026-11-18T12:00:00.000Z';
const OWN: ProvisionRunInput = { ownerId: 'bo', recordId: 'provision-machine-desk~1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 7, reason: 'revision' };
const SECOND: ProvisionRunInput = { ownerId: 'bo', recordId: 'provision-machine-desk2~1', target: { kind: 'machine', clusterId: 'machine-desk2', machine: 'desk-2', deviceId: 'device-desk-2' }, revision: 7, reason: 'missing' };

function world(answers: Partial<Record<string, ProvisionPieceResult>> = {}) {
  const store = new MemoryInfrastructureStore();
  const started: ProvisionPieceInput[] = [];
  const operations = createProvisionOperations({
    records: store,
    pieces: { run: async (piece) => { started.push(piece); return answers[piece.piece] ?? { ok: true }; } },
    now: () => AT,
  });
  const open = (inputs: ProvisionRunInput, ownerId = inputs.ownerId) => store.openProvisioning(openedRecord({ ownerId, target: inputs.target, revision: inputs.revision, reason: inputs.reason, runId: inputs.recordId, at: AT }));
  const run = async (inputs: ProvisionRunInput, opened = true) => {
    if (opened) await open(inputs, inputs.ownerId);
    return runOnHost({ procedure: PROVISION, operations, runId: inputs.recordId, agentId: PROVISION_AGENT, ownerId: inputs.ownerId, inputs });
  };
  const record = async (inputs: ProvisionRunInput) => (await store.getProvisioningRun(inputs.recordId))!;
  return { run, open, started, record };
}

describe('the provision procedure', () => {
  it('is the procedure the provision persona runs, and both ship in the provision extension', () => {
    const extension = INSTALLED_EXTENSIONS.find((entry) => entry.id === 'provision')!;
    expect(PROVISION.id).toBe(PROVISION_PROCEDURE);
    expect(extension.procedures?.map((procedure) => procedure.id)).toEqual([PROVISION_PROCEDURE]);
    expect(extension.personas?.find((persona) => persona.slug === PROVISION_AGENT)?.procedure).toBe(PROVISION_PROCEDURE);
  });

  it('sets up every piece of the Koala\'s own cluster in order, then marks the setup up', async () => {
    const { run, started, record: recordOf } = world();
    const result = await run(OWN);
    expect(result.outcome).toBe('ok');
    expect(started.map((piece) => piece.piece)).toEqual(PROVISION_PIECES.map((piece) => piece.key));
    expect(started.every((piece) => piece.recordId === OWN.recordId && piece.revision === 7)).toBe(true);
    const record = await recordOf(OWN);
    expect(record.state).toBe('up');
    expect(record.pieces.every((piece) => piece.state === 'up')).toBe(true);
  });

  it('stops at the first piece that can never come up, sets up nothing after it, and ends failed with its why', async () => {
    const { run, started, record: recordOf } = world({ gitea: { ok: false, why: 'pod gitea-0 is Init:Error: the volume is full' } });
    const result = await run(OWN);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('pod gitea-0 is Init:Error: the volume is full');
    expect(started.map((piece) => piece.piece)).toEqual(['egress', 'searxng', 'crawl4ai', 'gitea']);
    const record = await recordOf(OWN);
    expect(record).toMatchObject({ state: 'failed', why: 'Gitea, your repositories and images: pod gitea-0 is Init:Error: the volume is full' });
    expect(record.pieces.filter((piece) => piece.state === 'waiting').map((piece) => piece.key)).toEqual(['verdaccio', 'infisical', 'monitoring']);
  });

  it('ends failed with monitoring\'s why when the last piece cannot come up', async () => {
    const { run, record } = world({ monitoring: { ok: false, why: 'the CRDs never came up' } });
    const result = await run(OWN);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'the CRDs never came up' });
    expect(await record(OWN)).toMatchObject({ state: 'failed', why: 'Monitoring: the CRDs never came up' });
  });

  it('sets up only the collector on another of the person\'s machines', async () => {
    const { run, started, record } = world();
    const result = await run(SECOND);
    expect(result.outcome).toBe('ok');
    expect(started.map((piece) => [piece.piece, piece.target])).toEqual([['monitoring', SECOND.target]]);
    expect(await record(SECOND)).toMatchObject({ state: 'up', pieces: [{ key: 'monitoring', state: 'up' }] });
  });

  it('ends failed without touching anything when the run\'s record is someone else\'s', async () => {
    const { run, open, started, record } = world();
    await open(OWN, 'someone');
    const result = await run(OWN, false);
    expect(result).toMatchObject({ outcome: 'failed', reason: `the setup ${OWN.recordId} is not bo's` });
    expect(started).toEqual([]);
    expect(await record(OWN)).toMatchObject({ ownerId: 'someone', state: 'running' });
  });

  it('ends failed, starting nothing, when Koala opened no record for the run', async () => {
    const { run, started } = world();
    expect(await run(OWN, false)).toMatchObject({ outcome: 'failed', reason: `the setup ${OWN.recordId} is no longer recorded` });
    expect(started).toEqual([]);
  });
});
