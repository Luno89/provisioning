import { describe, it, expect, beforeEach } from 'vitest';
import type { NodeRequest } from '@koala/agent-engine/procedure';
import { openedRecord, type ProvisionPieceInput, type ProvisionPieceResult, type ProvisioningRecord, type ProvisionRunInput } from '../../../infrastructure/lib/provisioning.js';
import { createProvisionOperations } from './handlers.js';

const AT = '2026-11-18T12:00:00.000Z';

const input: ProvisionRunInput = { ownerId: 'bo', recordId: 'provision-machine-desk~1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 7, reason: 'revision' };
const collector: ProvisionRunInput = { ownerId: 'bo', recordId: 'provision-machine-desk2~1', target: { kind: 'machine', clusterId: 'machine-desk2', machine: 'desk-2' }, revision: 7, reason: 'missing' };

let records: Map<string, ProvisioningRecord>;
let started: ProvisionPieceInput[];
let answers: Record<string, ProvisionPieceResult | Error>;
let signals: (AbortSignal | undefined)[];

const ops = () => createProvisionOperations({
  records: {
    get: async (recordId) => records.get(recordId),
    save: async (record) => { records.set(record.id, record); },
  },
  pieces: {
    run: async (piece, signal) => {
      started.push(piece);
      signals.push(signal);
      const answer = answers[piece.piece] ?? { ok: true };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
  now: () => AT,
});

const request = (runInputs: unknown, settings: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}, signal?: AbortSignal) => ({
  inputs, node: { settings }, run: { inputs: runInputs, ...(signal ? { signal } : {}) },
}) as unknown as NodeRequest;

const opened = (given: ProvisionRunInput) => openedRecord({ ownerId: given.ownerId, target: given.target, revision: given.revision, reason: given.reason, runId: given.recordId, at: AT });

const pieceOf = (recordId: string, key: string) => records.get(recordId)?.pieces.find((piece) => piece.key === key);

beforeEach(() => {
  records = new Map();
  started = [];
  answers = {};
  signals = [];
});

describe('opening a setup', () => {
  it('records the run with every piece waiting when the record is not there yet, and says which kind of cluster it sets up', async () => {
    const result = await ops()['provision.open']!(request(input));
    expect(result).toEqual({ exit: 'done', outputs: { kind: 'koala' } });
    const record = records.get(input.recordId)!;
    expect(record).toMatchObject({ id: input.recordId, runId: input.recordId, ownerId: 'bo', revision: 7, reason: 'revision', state: 'running', startedAt: AT });
    expect(record.pieces.map((piece) => [piece.key, piece.state])).toEqual([
      ['egress', 'waiting'], ['searxng', 'waiting'], ['crawl4ai', 'waiting'], ['gitea', 'waiting'], ['verdaccio', 'waiting'], ['infisical', 'waiting'], ['monitoring', 'waiting'],
    ]);
  });

  it('keeps the record the run was started with, and opens another machine\'s setup with its collector alone', async () => {
    records.set(collector.recordId, opened(collector));
    const result = await ops()['provision.open']!(request(collector));
    expect(result).toEqual({ exit: 'done', outputs: { kind: 'machine' } });
    expect(records.get(collector.recordId)!.pieces).toEqual([{ key: 'monitoring', title: "desk-2's collector", state: 'waiting' }]);
  });

  it('fails with why when the record is someone else\'s, is for another cluster, or has already ended', async () => {
    records.set(input.recordId, { ...opened(input), ownerId: 'someone' });
    expect(await ops()['provision.open']!(request(input))).toEqual({ exit: 'failed', outputs: { reason: `the setup ${input.recordId} is not bo's` } });
    records.set(input.recordId, { ...opened(input), target: { kind: 'koala', clusterId: 'machine-other' } });
    expect(await ops()['provision.open']!(request(input))).toEqual({ exit: 'failed', outputs: { reason: `the setup ${input.recordId} is for machine-other, not machine-desk` } });
    records.set(input.recordId, { ...opened(input), state: 'failed', why: 'Gitea: it broke', endedAt: AT });
    expect(await ops()['provision.open']!(request(input))).toEqual({ exit: 'failed', outputs: { reason: `the setup ${input.recordId} has already ended failed` } });
  });

  it('refuses a run started without a setup in its inputs', async () => {
    await expect(ops()['provision.open']!(request({ ownerId: 'bo' }))).rejects.toThrow(/not started for a setup/);
    await expect(ops()['provision.open']!(request({ ...input, revision: 0 }))).rejects.toThrow(/not started for a setup/);
    await expect(ops()['provision.open']!(request({ ...input, target: { kind: 'machine', clusterId: 'x' } }))).rejects.toThrow(/not started for a setup/);
  });
});

describe('setting up a piece', () => {
  beforeEach(() => { records.set(input.recordId, opened(input)); });

  it('starts the piece on the cluster, records it working while it runs and up once it is', async () => {
    let during: string | undefined;
    const operations = createProvisionOperations({
      records: { get: async (id) => records.get(id), save: async (record) => { records.set(record.id, record); } },
      pieces: { run: async (piece) => { started.push(piece); during = pieceOf(input.recordId, piece.piece)?.state; return { ok: true }; } },
      now: () => AT,
    });
    const result = await operations['provision.service']!(request(input, { service: 'gitea' }));
    expect(result).toEqual({ exit: 'done', outputs: {} });
    expect(started).toEqual([{ ownerId: 'bo', recordId: input.recordId, target: input.target, revision: 7, piece: 'gitea' }]);
    expect(during).toBe('working');
    expect(pieceOf(input.recordId, 'gitea')).toEqual({ key: 'gitea', title: 'Gitea, your repositories and images', state: 'up', at: AT });
    expect(records.get(input.recordId)!.state).toBe('running');
  });

  it('hands the run\'s stop to the piece, so stopping the run stops the piece', async () => {
    const stop = new AbortController();
    await ops()['provision.service']!(request(input, { service: 'egress' }, {}, stop.signal));
    expect(signals).toEqual([stop.signal]);
  });

  it('fails with the piece\'s own why when it can never come up, and the record says which piece and why', async () => {
    answers.infisical = { ok: false, why: 'pod infisical-0 is CrashLoopBackOff: out of memory' };
    const result = await ops()['provision.service']!(request(input, { service: 'infisical' }));
    expect(result).toEqual({ exit: 'failed', outputs: { reason: 'pod infisical-0 is CrashLoopBackOff: out of memory' } });
    expect(pieceOf(input.recordId, 'infisical')).toMatchObject({ state: 'failed', why: 'pod infisical-0 is CrashLoopBackOff: out of memory' });
    expect(records.get(input.recordId)).toMatchObject({ state: 'failed', why: 'Infisical, your secrets: pod infisical-0 is CrashLoopBackOff: out of memory' });
  });

  it('fails with why when the piece could not be followed at all', async () => {
    answers.searxng = new Error('Temporal is not answering: connection refused');
    const result = await ops()['provision.service']!(request(input, { service: 'searxng' }));
    expect(result).toEqual({ exit: 'failed', outputs: { reason: 'Temporal is not answering: connection refused' } });
    expect(pieceOf(input.recordId, 'searxng')).toMatchObject({ state: 'failed', why: 'Temporal is not answering: connection refused' });
  });

  it('sets up monitoring as its own piece, and only the collector on another machine', async () => {
    records.set(collector.recordId, opened(collector));
    expect(await ops()['provision.monitoring']!(request(input))).toEqual({ exit: 'done', outputs: {} });
    expect(await ops()['provision.monitoring']!(request(collector))).toEqual({ exit: 'done', outputs: {} });
    expect(started.map((piece) => [piece.recordId, piece.piece, piece.target.kind])).toEqual([[input.recordId, 'monitoring', 'koala'], [collector.recordId, 'monitoring', 'machine']]);
    expect(pieceOf(collector.recordId, 'monitoring')).toMatchObject({ title: "desk-2's collector", state: 'up' });
  });

  it('fails without starting anything when the record is gone or the service is not a platform service', async () => {
    records.clear();
    expect(await ops()['provision.service']!(request(input, { service: 'gitea' }))).toEqual({ exit: 'failed', outputs: { reason: `the setup ${input.recordId} is no longer recorded` } });
    records.set(input.recordId, opened(input));
    expect(await ops()['provision.service']!(request(input, { service: 'monitoring' }))).toEqual({ exit: 'failed', outputs: { reason: 'monitoring is not one of egress, searxng, crawl4ai, gitea, verdaccio, infisical' } });
    records.set(collector.recordId, opened(collector));
    expect(await ops()['provision.service']!(request(collector, { service: 'gitea' }))).toEqual({ exit: 'failed', outputs: { reason: 'the setup of desk-2 has no piece gitea' } });
    expect(started).toEqual([]);
  });
});

describe('marking a setup', () => {
  beforeEach(() => { records.set(input.recordId, opened(input)); });

  it('marks it up once every piece is, and refuses with why while one is not', async () => {
    expect(await ops()['provision.mark']!(request(input, { state: 'up' }))).toEqual({ exit: 'failed', outputs: { reason: 'the setup of machine-desk cannot be up while egress, searxng, crawl4ai, gitea, verdaccio, infisical, monitoring are not' } });
    expect(records.get(input.recordId)!.state).toBe('running');
    const record = records.get(input.recordId)!;
    records.set(input.recordId, { ...record, pieces: record.pieces.map((piece) => ({ ...piece, state: 'up' as const })) });
    expect(await ops()['provision.mark']!(request(input, { state: 'up' }))).toEqual({ exit: 'done', outputs: {} });
    expect(records.get(input.recordId)).toMatchObject({ state: 'up', endedAt: AT });
  });

  it('marks it failed with the reason it was handed, failing the piece under way, and leaves a run that already failed as it was', async () => {
    const record = records.get(input.recordId)!;
    records.set(input.recordId, { ...record, pieces: record.pieces.map((piece) => (piece.key === 'egress' ? { ...piece, state: 'working' as const } : piece)) });
    expect(await ops()['provision.mark']!(request(input, { state: 'failed' }, { reason: 'the egress proxy never answered' }))).toEqual({ exit: 'done', outputs: {} });
    expect(records.get(input.recordId)).toMatchObject({ state: 'failed', why: 'the egress proxy never answered', endedAt: AT });
    expect(pieceOf(input.recordId, 'egress')).toMatchObject({ state: 'failed', why: 'the egress proxy never answered' });
    expect(await ops()['provision.mark']!(request(input, { state: 'failed' }, { reason: 'something later' }))).toEqual({ exit: 'done', outputs: {} });
    expect(records.get(input.recordId)!.why).toBe('the egress proxy never answered');
  });

  it('fails with why when the record is gone', async () => {
    records.clear();
    expect(await ops()['provision.mark']!(request(input, { state: 'up' }))).toEqual({ exit: 'failed', outputs: { reason: `the setup ${input.recordId} is no longer recorded` } });
  });
});
