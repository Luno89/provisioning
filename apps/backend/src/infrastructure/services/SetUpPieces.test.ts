import { describe, expect, it } from 'vitest';
import type { ProvisionTarget } from '@koala/engine-core/koala-install';
import { MemoryInfrastructureStore } from '../testing/memory-store.js';
import { openedRecord, pieceHeard, type ProvisioningRecord } from '../lib/provisioning.js';
import { NO_CLUSTER_OF_ITS_OWN, SetUpPieces } from './SetUpPieces.js';

const KOALA: ProvisionTarget = { kind: 'koala', clusterId: 'machine-desk' };
const LAB: ProvisionTarget = { kind: 'machine', clusterId: 'machine-lab', machine: 'lab', deviceId: 'device-lab' };

const run = (target: ProvisionTarget, stamp: string): ProvisioningRecord =>
  openedRecord({ ownerId: 'owner-1', target, revision: 4, reason: 'revision', runId: `provision-${target.clusterId}~${stamp}`, at: `2026-11-18T10:00:0${stamp.length}.000Z` });

const allUp = (record: ProvisioningRecord): ProvisioningRecord => ({ ...record, state: 'up', pieces: record.pieces.map((piece) => ({ ...piece, state: 'up' as const })) });

function setUp() {
  const store = new MemoryInfrastructureStore();
  const lines: string[] = [];
  const started: string[] = [];
  const pieces = new SetUpPieces({ store, clusterId: KOALA.clusterId }, (line) => lines.push(line));
  const start = (what: string) => () => { started.push(what); };
  const pieceUp = async (record: ProvisioningRecord, stage: 'egress' | 'gitea', title: string): Promise<ProvisioningRecord> => {
    const heard = pieceHeard(record, { stage, title, state: 'done' }, '2026-11-18T10:01:00.000Z');
    await store.patchProvisioning(record.id, { pieces: heard.pieces });
    return heard;
  };
  return { store, lines, started, pieces, start, pieceUp };
}

describe('work that needs one of Koala\'s setup pieces', () => {
  it('waits, saying so, until its own cluster\'s setup brings that piece up, and starts once a run', async () => {
    const { store, lines, started, pieces, start, pieceUp } = setUp();
    const opened = run(KOALA, 'a');
    await store.openProvisioning(opened);
    await pieces.follow();
    pieces.whenUp('gitea', 'making every Gitea user private', start('private'));
    expect(lines).toEqual(['[setup] making every Gitea user private waits for Gitea, your repositories and images to be set up']);

    const working = pieceHeard(opened, { stage: 'gitea', title: 'Gitea, your repositories and images', state: 'started', line: 'deployment/gitea: 0 of 1 ready' }, '2026-11-18T10:00:30.000Z');
    await store.patchProvisioning(opened.id, { pieces: working.pieces });
    const egressUp = await pieceUp(working, 'egress', 'The egress proxy');
    expect(started).toEqual([]);

    const lab = run(LAB, 'l');
    await store.openProvisioning(allUp(lab));
    expect(started).toEqual([]);

    const giteaUp = await pieceUp(egressUp, 'gitea', 'Gitea, your repositories and images');
    await store.patchProvisioning(opened.id, { pieces: giteaUp.pieces, state: 'up' });
    expect(started).toEqual(['private']);
    await pieces.close();
  });

  it('starts at once at a restart that the revision\'s setup already brought the piece up, and again when a new run brings it up', async () => {
    const { store, lines, started, pieces, start, pieceUp } = setUp();
    await store.openProvisioning(allUp(run(KOALA, 'a')));
    await pieces.follow();
    pieces.whenUp('egress', 'keeping the egress proxy in step', start('egress'));
    expect(started).toEqual(['egress']);
    expect(lines).toEqual([]);

    const again = run(KOALA, 'bb');
    await store.openProvisioning(again);
    expect(started).toEqual(['egress']);
    await pieceUp(again, 'egress', 'The egress proxy');
    expect(started).toEqual(['egress', 'egress']);
    await pieces.close();
  });

  it('never starts where nothing is set up, and says why', () => {
    const lines: string[] = [];
    const pieces = new SetUpPieces({ off: NO_CLUSTER_OF_ITS_OWN }, (line) => lines.push(line));
    let started = false;
    pieces.whenUp('gitea', 'making every Gitea user private', () => { started = true; });
    expect(started).toBe(false);
    expect(lines).toEqual(['[setup] making every Gitea user private does not start, since Gitea, your repositories and images is never set up here: this Koala names no machine and is on no pool, so it has no cluster of its own to set up']);
  });
});
