import { describe, expect, it } from 'vitest';
import { PROVISION_DONE_STAGE, PROVISION_MOVED_PIECE, PROVISION_PIECES, PROVISION_PROGRESS, provisionReportOf, type ProvisionTarget } from '@koala/engine-core/koala-install';
import { progressOf } from '@koala/engine-core/machine-progress';
import { PLATFORM_PLAN } from './platform-provision.js';
import {
  broughtOver, MOVE_IN_ID, openedRecord, pieceHeard, type MoveIn, pieceProgress, piecesFor, progressSince, provisionedFor, provisioningView, provisionPieceWorkflowId, provisionRunId,
  provisionWorkflowId, recordedOn, rootReportOf, runEnded, setUpProgress, startDecision, type HeardPatch, type ProvisioningRecord,
} from './provisioning.js';

const AT = '2026-11-18T12:00:00.000Z';
const LATER = '2026-11-18T12:05:00.000Z';
const KOALA: ProvisionTarget = { kind: 'koala', clusterId: 'machine-desk' };
const OTHER: ProvisionTarget = { kind: 'machine', clusterId: 'machine-desk-2', machine: 'desk-2', deviceId: 'device-desk-2' };

const opened = (over: Partial<Parameters<typeof openedRecord>[0]> = {}): ProvisioningRecord =>
  openedRecord({ ownerId: 'owner-1', target: KOALA, revision: 7, reason: 'revision', runId: provisionRunId('machine-desk', 's1'), at: AT, ...over });

describe('what a Koala sets up, and for which cluster', () => {
  it('sets up every piece on its own cluster, in order, its platform services named as their stacks are', () => {
    expect(piecesFor(KOALA).map((piece) => piece.key)).toEqual(PROVISION_PIECES.map((piece) => piece.key));
    expect(piecesFor(KOALA).filter((piece) => piece.key !== 'monitoring').map((piece) => piece.key)).toEqual(PLATFORM_PLAN.map((service) => service.key));
    expect(piecesFor(KOALA).every((piece) => piece.state === 'waiting')).toBe(true);
  });

  it('brings over what a move left as its last piece, only on the cluster the move came onto and only until it is brought over', () => {
    const moveIn: MoveIn = { id: MOVE_IN_ID, ownerId: 'owner-1', from: 'pool-shop', onto: 'machine-desk', at: AT };
    expect(piecesFor(KOALA, moveIn).map((piece) => piece.key)).toEqual([...PROVISION_PIECES.map((piece) => piece.key), PROVISION_MOVED_PIECE.key]);
    expect(piecesFor(KOALA, moveIn).at(-1)).toEqual({ key: 'moved', title: 'Bringing over your repositories, vault and apps', state: 'waiting' });
    expect(piecesFor(KOALA, { ...moveIn, broughtAt: LATER })).toEqual(piecesFor(KOALA));
    expect(piecesFor({ kind: 'koala', clusterId: 'machine-lab' }, moveIn)).toEqual(piecesFor({ kind: 'koala', clusterId: 'machine-lab' }));
    expect(piecesFor(OTHER, moveIn)).toEqual(piecesFor(OTHER));
    expect(opened({ moveIn }).pieces.at(-1)?.key).toBe('moved');
    expect(broughtOver(moveIn, LATER)).toEqual({ ...moveIn, broughtAt: LATER });
  });

  it('sets up only the collector on another of the person\'s machines, named for that machine', () => {
    expect(piecesFor(OTHER)).toEqual([{ key: 'monitoring', title: 'desk-2\'s collector', state: 'waiting' }]);
  });

  it('runs one setup at a time per cluster, each run and each piece of it under a name of its own', () => {
    expect(provisionWorkflowId('machine-desk')).toBe('provision-machine-desk');
    expect(provisionRunId('machine-desk', 's1')).toBe('provision-machine-desk~s1');
    expect(provisionPieceWorkflowId('provision-machine-desk~s1', 'gitea')).toBe('provision-machine-desk~s1~gitea');
  });
});

describe('when a setup starts', () => {
  const up = { ...opened(), state: 'up' as const };
  const failed = { ...opened(), state: 'failed' as const };

  it('starts on a revision nothing has set up yet, and only once per revision', () => {
    expect(startDecision([], KOALA, 7, 'revision')).toEqual({ start: true });
    expect(startDecision([up], KOALA, 8, 'revision')).toEqual({ start: true });
    expect(startDecision([up], KOALA, 7, 'revision')).toEqual({ start: false, already: up });
    expect(startDecision([failed], KOALA, 7, 'revision')).toEqual({ start: false, already: failed });
  });

  it('starts again when a piece is found missing or the person asks, whatever ran before', () => {
    expect(startDecision([up], KOALA, 7, 'missing')).toEqual({ start: true });
    expect(startDecision([failed], KOALA, 7, 'asked')).toEqual({ start: true });
  });

  it('joins the run under way on that cluster rather than starting a second', () => {
    const running = opened();
    for (const reason of ['revision', 'missing', 'asked'] as const) expect(startDecision([running], KOALA, 8, reason)).toEqual({ start: false, running });
    expect(startDecision([running], OTHER, 7, 'missing')).toEqual({ start: true });
  });
});

describe('a setup\'s record, as each piece reports', () => {
  it('opens with every piece waiting, and says why it ran', () => {
    expect(opened({ reason: 'asked' })).toEqual({
      id: 'provision-machine-desk~s1', runId: 'provision-machine-desk~s1', ownerId: 'owner-1', target: KOALA, revision: 7, reason: 'asked',
      state: 'running', pieces: piecesFor(KOALA), startedAt: AT,
    });
  });

  it('follows a piece from working, with what it waits on, to up, forgetting the line', () => {
    const working = pieceHeard(opened(), pieceProgress(opened(), 'gitea', { state: 'started', line: 'statefulset/gitea in gitea: 0 of 1 ready' }), AT);
    expect(working.pieces.find((piece) => piece.key === 'gitea')).toEqual({ key: 'gitea', title: 'Gitea, your repositories and images', state: 'working', line: 'statefulset/gitea in gitea: 0 of 1 ready', at: AT });
    const done = pieceHeard(working, pieceProgress(working, 'gitea', { state: 'done' }), LATER);
    expect(done.pieces.find((piece) => piece.key === 'gitea')).toEqual({ key: 'gitea', title: 'Gitea, your repositories and images', state: 'up', at: LATER });
    expect(done.state).toBe('running');
  });

  it('fails the run at the piece that failed, with the piece and why', () => {
    const failed = pieceHeard(opened(), pieceProgress(opened(), 'infisical', { state: 'failed', why: 'pod infisical-0 is CrashLoopBackOff' }), LATER);
    expect(failed).toMatchObject({ state: 'failed', why: 'Infisical, your secrets: pod infisical-0 is CrashLoopBackOff', endedAt: LATER });
    expect(failed.pieces.find((piece) => piece.key === 'infisical')).toMatchObject({ state: 'failed', why: 'pod infisical-0 is CrashLoopBackOff' });
  });

  it('is up only once every piece is, on the setup\'s own last stage', () => {
    let record = opened();
    expect(() => pieceHeard(record, setUpProgress(), LATER)).toThrow('the setup of machine-desk cannot be up while egress, searxng, crawl4ai, gitea, verdaccio, infisical, monitoring are not');
    for (const piece of PROVISION_PIECES) record = pieceHeard(record, pieceProgress(record, piece.key, { state: 'done' }), AT);
    expect(pieceHeard(record, setUpProgress(), LATER)).toMatchObject({ state: 'up', endedAt: LATER });
  });

  it('refuses a line for a piece this setup does not have', () => {
    const other = openedRecord({ ownerId: 'owner-1', target: OTHER, revision: 7, reason: 'missing', runId: provisionRunId('machine-desk-2', 's1'), at: AT });
    expect(() => pieceProgress(other, 'gitea', { state: 'done' })).toThrow('the setup of desk-2 has no piece gitea');
    expect(() => pieceHeard(other, { stage: 'gitea', title: 'Gitea', state: 'done' }, AT)).toThrow('the setup of desk-2 has no piece gitea');
  });

  it('says each line in the shape root takes, shortening a long reason', () => {
    const record = opened();
    for (const change of [{ state: 'started' as const, line: 'l' }, { state: 'done' as const }, { state: 'already-done' as const }, { state: 'failed' as const, why: 'w'.repeat(5000) }]) {
      expect(progressOf(pieceProgress(record, 'verdaccio', change), PROVISION_PROGRESS)).toMatchObject({ ok: true });
    }
    expect(progressOf(setUpProgress(), PROVISION_PROGRESS)).toMatchObject({ ok: true, value: { stage: PROVISION_DONE_STAGE, state: 'done' } });
  });

  it('fails a run whose workflow ended without saying how it went, leaving pieces that finished as they were', () => {
    const working = pieceHeard(pieceHeard(opened(), pieceProgress(opened(), 'egress', { state: 'done' }), AT), pieceProgress(opened(), 'searxng', { state: 'started' }), AT);
    const ended = runEnded(working, 'its workflow was cancelled', LATER);
    expect(ended).toMatchObject({ state: 'failed', why: 'its workflow was cancelled', endedAt: LATER });
    expect(ended.pieces.slice(0, 3).map((piece) => piece.state)).toEqual(['up', 'failed', 'waiting']);
    expect(ended.pieces[1]).toMatchObject({ why: 'its workflow was cancelled' });
    const up = { ...opened(), state: 'up' as const };
    expect(runEnded(up, 'gone', LATER)).toBe(up);
  });
});

describe('what others read of a setup', () => {
  it('shows the card the run without who ran it or its workflow', () => {
    const record = { ...opened(), workflowId: 'provision-machine-desk' };
    expect(provisioningView(record)).toEqual({ id: record.id, target: KOALA, revision: 7, reason: 'revision', state: 'running', pieces: record.pieces, startedAt: AT });
  });

  it('tells root only of the setup of the Koala\'s own cluster, in the report root accepts', () => {
    const progress = pieceProgress(opened(), 'gitea', { state: 'done' });
    const report = rootReportOf(opened(), progress);
    expect(report).toEqual({ revision: 7, progress });
    expect(provisionReportOf(report)).toEqual({ ok: true, value: report });
    const other = openedRecord({ ownerId: 'owner-1', target: OTHER, revision: 7, reason: 'missing', runId: 'r', at: AT });
    expect(rootReportOf(other, pieceProgress(other, 'monitoring', { state: 'done' }))).toBeUndefined();
  });

  it('answers whether a cluster is set up for a revision: up, failed with why, or what it still waits on', () => {
    expect(provisionedFor([], 'machine-desk', 7)).toEqual({ state: 'waiting', line: 'nothing has started setting up machine-desk for revision 7 yet' });
    const working = pieceHeard(opened(), pieceProgress(opened(), 'gitea', { state: 'started', line: 'pod gitea-0 is pulling' }), AT);
    expect(provisionedFor([working], 'machine-desk', 7)).toEqual({ state: 'waiting', line: 'Gitea, your repositories and images: pod gitea-0 is pulling' });
    const failed = { ...opened({ runId: 'provision-machine-desk~s2', at: LATER }), state: 'failed' as const, why: 'Gitea: boom' };
    expect(provisionedFor([working, failed], 'machine-desk', 7)).toEqual({ state: 'failed', why: 'Gitea: boom' });
    const up = { ...opened({ runId: 'provision-machine-desk~s3', at: '2026-11-18T13:00:00.000Z' }), state: 'up' as const };
    expect(provisionedFor([working, failed, up], 'machine-desk', 7)).toEqual({ state: 'up' });
    expect(provisionedFor([up], 'machine-desk', 8)).toMatchObject({ state: 'waiting' });
    expect(provisionedFor([up], 'machine-desk-2', 7)).toMatchObject({ state: 'waiting' });
  });
});

describe('what root hears of a setup, as its record changes', () => {
  it('says each piece that moved since root last heard, in order, and the setup\'s own last stage once it is up', () => {
    const egressWorking = pieceHeard(opened(), pieceProgress(opened(), 'egress', { state: 'started', line: 'deployment/egress-proxy: 0 of 1 ready' }), AT);
    expect(progressSince(opened(), egressWorking)).toEqual([{ stage: 'egress', title: 'The egress proxy', state: 'started', line: 'deployment/egress-proxy: 0 of 1 ready' }]);
    expect(progressSince(egressWorking, egressWorking)).toEqual([]);
    let all = egressWorking;
    for (const piece of PROVISION_PIECES) all = pieceHeard(all, pieceProgress(all, piece.key, { state: 'done' }), AT);
    const up = pieceHeard(all, setUpProgress(), LATER);
    expect(progressSince(egressWorking, up).map((line) => `${line.stage} ${line.state}`)).toEqual([...PROVISION_PIECES.map((piece) => `${piece.key} done`), `${PROVISION_DONE_STAGE} done`]);
  });

  it('says everything a run has done when root has heard none of it, as after a restart', () => {
    const working = pieceHeard(pieceHeard(opened(), pieceProgress(opened(), 'egress', { state: 'done' }), AT), pieceProgress(opened(), 'searxng', { state: 'started' }), AT);
    expect(progressSince(undefined, working).map((line) => `${line.stage} ${line.state}`)).toEqual(['egress done', 'searxng started']);
  });

  it('says where a run stopped when it failed without a piece failing, so root never waits on a run that ended', () => {
    const egressUp = pieceHeard(opened(), pieceProgress(opened(), 'egress', { state: 'done' }), AT);
    const ended = runEnded(egressUp, 'the setup\'s run was stopped', LATER);
    expect(progressSince(egressUp, ended)).toEqual([{ stage: 'searxng', title: 'SearXNG, web search', state: 'failed', why: 'the setup\'s run was stopped' }]);
    const failedPiece = pieceHeard(egressUp, pieceProgress(egressUp, 'searxng', { state: 'failed', why: 'no room' }), LATER);
    expect(progressSince(egressUp, failedPiece)).toEqual([{ stage: 'searxng', title: 'SearXNG, web search', state: 'failed', why: 'no room' }]);
  });
});

describe('writing what a piece says onto its run\'s record', () => {
  const kept = (record: ProvisioningRecord | undefined) => {
    let now = record;
    const patched: HeardPatch[] = [];
    return {
      patched,
      records: {
        getProvisioningRun: async () => now,
        patchProvisioning: async (_id: string, patch: HeardPatch) => {
          patched.push(patch);
          if (now?.state !== 'running') return undefined;
          now = { ...now, ...patch };
          return now;
        },
      },
    };
  };

  it('writes the record\'s state and pieces as one patch, only while the run is under way', async () => {
    const { records, patched } = kept(opened());
    const said = await recordedOn(records, opened().id, (record) => pieceHeard(record, pieceProgress(record, 'egress', { state: 'started', line: 'l' }), AT));
    expect(said).toMatchObject({ recorded: { state: 'running' } });
    expect(patched).toEqual([{ state: 'running', pieces: expect.arrayContaining([expect.objectContaining({ key: 'egress', state: 'working', line: 'l' })]) as unknown }]);
  });

  it('answers that the run ended, or is gone, rather than writing over it', async () => {
    const ended = { ...opened(), state: 'failed' as const, why: 'stopped', endedAt: LATER };
    expect(await recordedOn(kept(ended).records, ended.id, (record) => record)).toEqual({ ended });
    expect(await recordedOn(kept(undefined).records, 'nowhere', (record) => record)).toEqual({ gone: true });
  });
});
