import { describe, expect, it } from 'vitest';
import type { BenchSettings, BenchState } from '../lib/bench.js';
import type { ScriptedRequestRecord } from '../lib/check-script.js';
import type { EvalCollection, EvalRecord } from '../lib/eval-run.js';
import type { ChecksStore } from '../store.js';

interface Run extends EvalRecord {
  startedAt?: string;
  state?: string;
  note?: string;
}

const run = (ownerId: string, id: string, extra: Partial<Run> = {}): Run => ({ id, ownerId, startedAt: '2026-10-27T00:00:00.000Z', state: 'done', ...extra });

const request = (ownerId: string, at: string, text: string, extra: Partial<ScriptedRequestRecord> = {}): ScriptedRequestRecord => ({ ownerId, at, text, tools: ['read_file'], ...extra });

const settings: BenchSettings = { enabled: true, idleMinutes: 15, fullEveryHours: 24 };

export function checksStoreContract(make: () => Promise<ChecksStore>): void {
  describe('the requests a scripted model was asked', () => {
    it('keeps every request, in the order they came, and only the asking person\'s', async () => {
      const store = await make();
      await store.saveScriptedRequest(request('u1', '2026-10-27T00:00:02.000Z', 'second', { rule: 1 }));
      await store.saveScriptedRequest(request('u1', '2026-10-27T00:00:01.000Z', 'first', { miss: 'no rule answers' }));
      await store.saveScriptedRequest(request('u2', '2026-10-27T00:00:00.000Z', 'stranger'));
      expect(await store.getScriptedRequests('u1')).toEqual([
        request('u1', '2026-10-27T00:00:01.000Z', 'first', { miss: 'no rule answers' }),
        request('u1', '2026-10-27T00:00:02.000Z', 'second', { rule: 1 }),
      ]);
      expect((await store.getScriptedRequests('u2')).map((entry) => entry.text)).toEqual(['stranger']);
      expect(await store.getScriptedRequests('nobody')).toEqual([]);
    });

    it('keeps requests made at the same moment in the order they were saved, and the same request twice', async () => {
      const store = await make();
      const at = '2026-10-27T00:00:00.000Z';
      await store.saveScriptedRequest(request('u1', at, 'one'));
      await store.saveScriptedRequest(request('u1', at, 'two'));
      await store.saveScriptedRequest(request('u1', at, 'two'));
      await store.saveScriptedRequest(request('u1', at, 'three'));
      expect((await store.getScriptedRequests('u1')).map((entry) => entry.text)).toEqual(['one', 'two', 'two', 'three']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      const saved = request('u1', '2026-10-27T00:00:00.000Z', 'asked');
      await store.saveScriptedRequest(saved);
      saved.text = 'changed after saving';
      const [read] = await store.getScriptedRequests('u1');
      expect(read?.text).toBe('asked');
      read!.tools.push('changed');
      expect((await store.getScriptedRequests('u1'))[0]?.tools).toEqual(['read_file']);
    });
  });

  describe('when the bench runs', () => {
    it('keeps a person\'s settings, replaces them whole when saved again, and has none for someone else', async () => {
      const store = await make();
      expect(await store.getBenchSettings('u1')).toBeUndefined();
      await store.saveBenchSettings('u1', settings);
      await store.saveBenchSettings('u2', { enabled: false, idleMinutes: 5, fullEveryHours: 1 });
      expect(await store.getBenchSettings('u1')).toEqual(settings);
      await store.saveBenchSettings('u1', { ...settings, enabled: false });
      expect(await store.getBenchSettings('u1')).toEqual({ ...settings, enabled: false });
      expect(await store.getBenchSettings('u2')).toEqual({ enabled: false, idleMinutes: 5, fullEveryHours: 1 });
    });

    it('keeps a person\'s bench state, replaces it whole when saved again, and has none for someone else', async () => {
      const store = await make();
      expect(await store.getBenchState('u1')).toBeUndefined();
      const state: BenchState = { ownerId: 'u1', benched: { planner: 'abc' }, lastFullAt: '2026-10-27T00:00:00.000Z' };
      await store.saveBenchState(state);
      await store.saveBenchState({ ownerId: 'u2', benched: {} });
      expect(await store.getBenchState('u1')).toEqual(state);
      await store.saveBenchState({ ownerId: 'u1', benched: { planner: 'def', judge: 'ghi' } });
      expect(await store.getBenchState('u1')).toEqual({ ownerId: 'u1', benched: { planner: 'def', judge: 'ghi' } });
      expect(await store.getBenchState('u2')).toEqual({ ownerId: 'u2', benched: {} });
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveBenchSettings('u1', settings);
      await store.saveBenchState({ ownerId: 'u1', benched: { planner: 'abc' } });
      (await store.getBenchSettings('u1'))!.idleMinutes = 99;
      (await store.getBenchState('u1'))!.benched.planner = 'changed';
      expect((await store.getBenchSettings('u1'))?.idleMinutes).toBe(15);
      expect((await store.getBenchState('u1'))?.benched).toEqual({ planner: 'abc' });
    });
  });

  describe.each<EvalCollection>(['evalScenarioRuns', 'evalAgentChanges'])('records of check work in %s', (collection) => {
    it('keeps a record as saved, replaces it whole when saved again, and finds it by its person and id', async () => {
      const store = await make();
      await store.saveEvalRecord(collection, run('u1', 'r1', { note: 'first' }));
      expect(await store.getEvalRecord<Run>(collection, 'u1', 'r1')).toEqual(run('u1', 'r1', { note: 'first' }));
      await store.saveEvalRecord(collection, { id: 'r1', ownerId: 'u1', state: 'running' });
      expect(await store.getEvalRecord<Run>(collection, 'u1', 'r1')).toEqual({ id: 'r1', ownerId: 'u1', state: 'running' });
      expect(await store.getEvalRecords<Run>(collection, 'u1')).toHaveLength(1);
    });

    it('answers null for a record that is not there, or is another person\'s', async () => {
      const store = await make();
      await store.saveEvalRecord(collection, run('u1', 'r1'));
      expect(await store.getEvalRecord(collection, 'u1', 'never')).toBeNull();
      expect(await store.getEvalRecord(collection, 'u2', 'r1')).toBeNull();
    });

    it('lets two people each keep a record under the same id', async () => {
      const store = await make();
      await store.saveEvalRecord(collection, run('u1', 'same', { note: 'mine' }));
      await store.saveEvalRecord(collection, run('u2', 'same', { note: 'theirs' }));
      expect(await store.getEvalRecord<Run>(collection, 'u1', 'same')).toMatchObject({ note: 'mine' });
      expect(await store.getEvalRecord<Run>(collection, 'u2', 'same')).toMatchObject({ note: 'theirs' });
      await store.deleteEvalRecord(collection, 'u1', 'same');
      expect(await store.getEvalRecord(collection, 'u1', 'same')).toBeNull();
      expect(await store.getEvalRecord<Run>(collection, 'u2', 'same')).toMatchObject({ note: 'theirs' });
    });

    it('lists a person\'s records newest started first, and only theirs', async () => {
      const store = await make();
      await store.saveEvalRecord(collection, run('u1', 'old', { startedAt: '2026-10-25T00:00:00.000Z' }));
      await store.saveEvalRecord(collection, run('u1', 'new', { startedAt: '2026-10-29T00:00:00.000Z' }));
      await store.saveEvalRecord(collection, run('u1', 'mid', { startedAt: '2026-10-27T00:00:00.000Z' }));
      await store.saveEvalRecord(collection, run('u2', 'stranger', { startedAt: '2026-10-30T00:00:00.000Z' }));
      expect((await store.getEvalRecords<Run>(collection, 'u1')).map((entry) => entry.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.getEvalRecords<Run>(collection, 'u2')).map((entry) => entry.id)).toEqual(['stranger']);
      expect(await store.getEvalRecords(collection, 'nobody')).toEqual([]);
    });

    it('lists records started at the same moment by id, and those never started last', async () => {
      const store = await make();
      const at = '2026-10-27T00:00:00.000Z';
      await store.saveEvalRecord(collection, run('u1', 'b', { startedAt: at }));
      await store.saveEvalRecord(collection, { id: 'unstarted', ownerId: 'u1' });
      await store.saveEvalRecord(collection, run('u1', 'a', { startedAt: at }));
      await store.saveEvalRecord(collection, run('u1', 'c', { startedAt: '2026-10-28T00:00:00.000Z' }));
      expect((await store.getEvalRecords<Run>(collection, 'u1')).map((entry) => entry.id)).toEqual(['c', 'a', 'b', 'unstarted']);
    });

    it('lists at most the number asked for, 200 when none is, and all of them for 0', async () => {
      const store = await make();
      for (let n = 0; n < 205; n += 1) {
        await store.saveEvalRecord(collection, run('u1', `r${String(n).padStart(3, '0')}`, { startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString() }));
      }
      expect(await store.getEvalRecords(collection, 'u1')).toHaveLength(200);
      expect((await store.getEvalRecords<Run>(collection, 'u1', 3)).map((entry) => entry.id)).toEqual(['r204', 'r203', 'r202']);
      expect(await store.getEvalRecords(collection, 'u1', 0)).toHaveLength(205);
      expect(await store.getEvalRecords(collection, 'u1', 500)).toHaveLength(205);
    });

    it('finds every person\'s records in one state', async () => {
      const store = await make();
      await store.saveEvalRecord(collection, run('u1', 'a', { state: 'running' }));
      await store.saveEvalRecord(collection, run('u2', 'b', { state: 'running' }));
      await store.saveEvalRecord(collection, run('u1', 'c', { state: 'done' }));
      expect((await store.getEvalRecordsInState<Run>(collection, 'running')).map((entry) => entry.id).sort()).toEqual(['a', 'b']);
      expect(await store.getEvalRecordsInState(collection, 'never')).toEqual([]);
    });

    it('forgets a record when deleted, and says nothing of one that was never there', async () => {
      const store = await make();
      await store.saveEvalRecord(collection, run('u1', 'r1'));
      await store.deleteEvalRecord(collection, 'u1', 'r1');
      await store.deleteEvalRecord(collection, 'u1', 'never');
      expect(await store.getEvalRecord(collection, 'u1', 'r1')).toBeNull();
      expect(await store.getEvalRecords(collection, 'u1')).toEqual([]);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveEvalRecord(collection, run('u1', 'r1', { note: 'kept' }));
      (await store.getEvalRecord<Run>(collection, 'u1', 'r1'))!.note = 'changed';
      (await store.getEvalRecords<Run>(collection, 'u1'))[0]!.note = 'changed';
      (await store.getEvalRecordsInState<Run>(collection, 'done'))[0]!.note = 'changed';
      expect((await store.getEvalRecord<Run>(collection, 'u1', 'r1'))?.note).toBe('kept');
    });
  });

  it('keeps each collection of records apart', async () => {
    const store = await make();
    await store.saveEvalRecord('evalScenarioRuns', run('u1', 'r1', { note: 'a run' }));
    await store.saveEvalRecord('evalScenarios', run('u1', 'r1', { note: 'a scenario' }));
    expect(await store.getEvalRecord<Run>('evalScenarioRuns', 'u1', 'r1')).toMatchObject({ note: 'a run' });
    expect(await store.getEvalRecord<Run>('evalScenarios', 'u1', 'r1')).toMatchObject({ note: 'a scenario' });
    await store.deleteEvalRecord('evalScenarioRuns', 'u1', 'r1');
    expect(await store.getEvalRecord('evalScenarios', 'u1', 'r1')).not.toBeNull();
    expect(await store.getEvalRecords('evalCases', 'u1')).toEqual([]);
  });
}
