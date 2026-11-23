import { describe, expect, it } from 'vitest';
import { PROVISION_PIECES, type ProvisionPieceView } from '@koala/engine-core/koala-install';
import { againPieces, openedRecord, type ProvisionPieceInput, type ProvisionPieceResult, type ProvisionRunInput } from '../../infrastructure/lib/provisioning.js';
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
  let working = 0;
  let most = 0;
  const operations = createProvisionOperations({
    records: store,
    pieces: {
      run: async (piece) => {
        started.push(piece);
        working += 1;
        most = Math.max(most, working);
        await new Promise((resolve) => { setImmediate(resolve); });
        working -= 1;
        return answers[piece.piece] ?? { ok: true };
      },
    },
    now: () => AT,
  });
  const open = (inputs: ProvisionRunInput, ownerId = inputs.ownerId, pieces?: ProvisionPieceView[]) => store.openProvisioning(openedRecord({ ownerId, target: inputs.target, revision: inputs.revision, reason: inputs.reason, runId: inputs.recordId, at: AT, pieces }));
  const run = async (inputs: ProvisionRunInput, opened = true) => {
    if (opened) await open(inputs, inputs.ownerId);
    return runOnHost({ procedure: PROVISION, operations, runId: inputs.recordId, agentId: PROVISION_AGENT, ownerId: inputs.ownerId, inputs });
  };
  const record = async (inputs: ProvisionRunInput) => (await store.getProvisioningRun(inputs.recordId))!;
  return { run, open, started, record, busiest: () => most };
}

describe('the provision procedure', () => {
  it('is the procedure the provision persona runs, and both ship in the provision extension', () => {
    const extension = INSTALLED_EXTENSIONS.find((entry) => entry.id === 'provision')!;
    expect(PROVISION.id).toBe(PROVISION_PROCEDURE);
    expect(extension.procedures?.map((procedure) => procedure.id)).toEqual([PROVISION_PROCEDURE]);
    expect(extension.personas?.find((persona) => persona.slug === PROVISION_AGENT)?.procedure).toBe(PROVISION_PROCEDURE);
  });

  it('starts every piece of the Koala\'s own cluster at once, and marks the setup up once every piece is', async () => {
    const { run, started, record: recordOf, busiest } = world();
    const result = await run(OWN);
    expect(result.outcome).toBe('ok');
    expect(busiest()).toBe(PROVISION_PIECES.length);
    expect(started.map((piece) => piece.piece).sort()).toEqual(PROVISION_PIECES.map((piece) => piece.key).sort());
    expect(started.every((piece) => piece.recordId === OWN.recordId && piece.revision === 7)).toBe(true);
    const record = await recordOf(OWN);
    expect(record.state).toBe('up');
    expect(record.pieces.every((piece) => piece.state === 'up')).toBe(true);
  });

  it('sets up every other piece when one can never come up, then ends failed naming every piece that did not and why', async () => {
    const { run, started, record: recordOf } = world({
      gitea: { ok: false, why: 'pod gitea-0 is Init:Error: the volume is full' },
      tei: { ok: false, why: 'the model could not be downloaded' },
    });
    const result = await run(OWN);
    const why = 'TEI, the memory index\'s embeddings: the model could not be downloaded; Gitea, your repositories and images: pod gitea-0 is Init:Error: the volume is full';
    expect(result).toMatchObject({ outcome: 'failed', reason: why });
    expect(started.map((piece) => piece.piece).sort()).toEqual(PROVISION_PIECES.map((piece) => piece.key).sort());
    const record = await recordOf(OWN);
    expect(record).toMatchObject({ state: 'failed', why });
    expect(record.pieces.filter((piece) => piece.state !== 'up').map((piece) => [piece.key, piece.state])).toEqual([['tei', 'failed'], ['gitea', 'failed']]);
  });

  it('set up again, sets up only the pieces that are not up and leaves the finished ones as they are', async () => {
    const first = world({ gitea: { ok: false, why: 'the volume is full' }, monitoring: { ok: false, why: 'the CRDs never came up' } });
    await first.run(OWN);
    const stopped = await first.record(OWN);
    const again: ProvisionRunInput = { ...OWN, recordId: 'provision-machine-desk~2', reason: 'asked' };
    const { open, run, started, record: recordOf } = world();
    await open(again, again.ownerId, againPieces(stopped, again.target, again.revision));
    const result = await run(again, false);
    expect(result.outcome).toBe('ok');
    expect(started.map((piece) => piece.piece).sort()).toEqual(['gitea', 'monitoring']);
    const record = await recordOf(again);
    expect(record.state).toBe('up');
    const finished = (pieces: readonly ProvisionPieceView[]) => pieces.filter((piece) => piece.key !== 'gitea' && piece.key !== 'monitoring');
    expect(finished(record.pieces)).toEqual(finished(stopped.pieces));
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
