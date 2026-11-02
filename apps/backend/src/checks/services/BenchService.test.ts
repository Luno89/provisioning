import { beforeEach, describe, expect, it } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import type { PromptChange } from '../../engine/lib/agent-changes.js';
import type { MemoryItem } from '../../memory/lib/memory-store.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { anyOf } from '../../platform/lib/test-matchers.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { BenchService, type BenchDeps, type Trials } from './BenchService.js';
import type { Level2Run } from './Level2Service.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();

type Scenarios = Awaited<ReturnType<BenchDeps['scenarios']>>;

const SCENARIOS: Scenarios = [
  { id: 'koala-cluster', agent: 'koala', tools: ['list_infrastructure', 'playwright__browser_snapshot'] },
  { id: 'executor-hello', agent: 'executor', tools: ['start_task', 'mark_done', 'playwright__browser_click'] },
  { id: 'koala-long-story', agent: 'koala', onBench: false, tools: ['start_task'] },
];

let db: Database;
let practices: ReturnType<typeof mock<Trials>>;
let notes: ReturnType<typeof mock<Trials>>;
let changes: ReturnType<typeof mock<BenchDeps['changes']>>;
let start: ReturnType<typeof mockFn<BenchDeps['start']>>;
let serving: ReturnType<typeof mockFn<BenchDeps['serving']>>;
let idleTimer: ReturnType<typeof mockFn<BenchDeps['idleTimer']>>;
let notify: ReturnType<typeof mockFn<BenchDeps['notify']>>;
let notifyChange: ReturnType<typeof mockFn<BenchDeps['notifyChange']>>;
let earlier: ReturnType<typeof mockFn<BenchDeps['earlier']>>;
let agentsRunning: ReturnType<typeof mockFn<BenchDeps['agentsRunning']>>;
let benchRunning: ReturnType<typeof mockFn<BenchDeps['benchRunning']>>;
let prints: Record<string, string>;
let scenarios: Scenarios;

const bench = (over: Partial<BenchDeps> = {}) => new BenchService({
  store: db,
  scenarios: async () => scenarios,
  fingerprints: async () => prints,
  start,
  serving,
  changes,
  earlier,
  notifyChange,
  practices,
  notes,
  benchRunning,
  agentsRunning,
  idleTimer,
  notify,
  now: () => NOW,
  ...over,
});

const account = (id: string, over: Partial<UserMetadata> = {}) => db.accounts.saveUser({ id, email: `${id}@example.com`, emailVerified: true, createdAt: NOW_ISO, ...over } as UserMetadata);

const trialItem = (id: string, over: Partial<MemoryItem>): MemoryItem => ({ id, ownerId: 'u1', category: 'practice', status: 'trial', title: id, text: id, createdAt: id, updatedAt: id, ...over });

beforeEach(async () => {
  db = memoryDatabase();
  await account('u1');
  practices = mock<Trials>();
  practices.trials.mockResolvedValue([]);
  notes = mock<Trials>();
  notes.trials.mockResolvedValue([]);
  changes = mock<BenchDeps['changes']>();
  changes.pending.mockResolvedValue([]);
  start = mockFn<BenchDeps['start']>();
  serving = mockFn<BenchDeps['serving']>();
  idleTimer = mockFn<BenchDeps['idleTimer']>();
  notify = mockFn<BenchDeps['notify']>();
  notifyChange = mockFn<BenchDeps['notifyChange']>();
  earlier = mockFn<BenchDeps['earlier']>();
  earlier.mockResolvedValue([]);
  agentsRunning = mockFn<BenchDeps['agentsRunning']>();
  agentsRunning.mockResolvedValue(false);
  benchRunning = mockFn<BenchDeps['benchRunning']>();
  benchRunning.mockResolvedValue(false);
  prints = { koala: 'k1', executor: 'e1' };
  scenarios = SCENARIOS;
});

describe('the bench', () => {
  it('restarts its idle countdown whenever a top-level run starts or ends, with the owner\'s idle time', async () => {
    await db.checks.saveBenchSettings('u1', { enabled: true, idleMinutes: 30, fullEveryHours: 24 });

    await bench().activity({ kind: 'run-started', ownerId: 'u1', runId: 'r', agentSlug: 'koala', depth: 0 });
    await bench().activity({ kind: 'run-ended', ownerId: 'u1', runId: 'r', agentSlug: 'koala', outcome: 'ok', ask: 'x', depth: 0 });
    await bench().activity({ kind: 'run-ended', ownerId: 'u1', runId: 'child', agentSlug: 'research', outcome: 'ok', ask: 'x', depth: 1 });

    expect(idleTimer.mock.calls).toEqual([['u1', 30 * 60_000], ['u1', 30 * 60_000]]);
  });

  it('restarts the countdown when something the bench judges changed, and not when a conversation merely went quiet', async () => {
    await db.checks.saveBenchSettings('u1', { enabled: true, idleMinutes: 5, fullEveryHours: 24 });
    await bench().changed('u1');
    await bench().activity({ kind: 'conversation-quiet', ownerId: 'u1', conversationId: 'c1' } as never);
    expect(idleTimer.mock.calls).toEqual([['u1', 5 * 60_000]]);
  });

  it('counts nothing down when it is switched off', async () => {
    await db.checks.saveBenchSettings('u1', { enabled: false, idleMinutes: 30, fullEveryHours: 24 });
    await bench().activity({ kind: 'run-started', ownerId: 'u1', runId: 'r', agentSlug: 'koala', depth: 0 });
    expect(idleTimer).not.toHaveBeenCalled();
  });

  it('counts nothing down for a check\'s space, an account being removed, or one already gone', async () => {
    await account('space-1', { space: { person: 'u1', checkRunId: 'c', scenarioId: 's' } } as Partial<UserMetadata>);
    await account('leaving', { removal: { startedAt: NOW_ISO, requestedBy: 'leaving' } });
    for (const ownerId of ['space-1', 'leaving', 'gone']) {
      await bench().activity({ kind: 'run-ended', ownerId, runId: 'r', agentSlug: 'koala', outcome: 'ok', ask: 'x', depth: 0 });
    }
    expect(idleTimer).not.toHaveBeenCalled();
  });

  it('runs everything the first time the model is idle, then only what changed', async () => {
    expect(await bench().idle('u1')).toBe('started');
    expect(start.mock.calls[0]![1]).toEqual({ trigger: { kind: 'full' }, scenarioIds: ['koala-cluster', 'executor-hello'] });
    expect(await bench().idle('u1')).toBe('nothing');

    prints = { koala: 'k2', executor: 'e1' };
    expect(await bench().idle('u1')).toBe('started');
    expect(start.mock.calls[1]![1]).toEqual({ trigger: { kind: 'changed', agents: ['koala'] }, scenarioIds: ['koala-cluster'] });
    expect(await bench().idle('u1')).toBe('nothing');
    expect(await db.checks.getBenchState('u1')).toMatchObject({ benched: { koala: 'k2', executor: 'e1' }, lastFullAt: NOW_ISO });
  });

  it('waits when an agent or the bench is still running, rather than competing with it for the model', async () => {
    agentsRunning.mockResolvedValue(true);
    expect(await bench().idle('u1')).toBe('busy');
    agentsRunning.mockResolvedValue(false);
    benchRunning.mockResolvedValue(true);
    expect(await bench().idle('u1')).toBe('busy');
    expect(start).not.toHaveBeenCalled();
  });

  it('tells the owner about a run with regressions, and only then', async () => {
    const run = { id: 'run-1', ownerId: 'u1', regressions: ['koala-cluster'] } as Level2Run;
    await bench().finished(run);
    await bench().finished({ ...run, regressions: [] });
    expect(notify.mock.calls).toEqual([['u1', run]]);
  });

  it('tries a practice on trial first, running only its agent\'s scenarios with it', async () => {
    practices.trials.mockResolvedValue([trialItem('p1', { agent: 'koala' })]);
    expect(await bench().idle('u1')).toBe('started');
    expect(start).toHaveBeenCalledWith('u1', { trigger: { kind: 'practice', agent: 'koala', practiceId: 'p1' }, scenarioIds: ['koala-cluster'] }, { trialPractice: 'p1' });
  });

  it('tries a practice kept for one model on that model, and leaves it on trial while nothing serves that model', async () => {
    practices.trials.mockResolvedValue([trialItem('gone', { agent: 'koala', model: 'old/model', createdAt: 'a' }), trialItem('here', { agent: 'koala', model: 'qwen/q', createdAt: 'b' })]);
    serving.mockImplementation(async (_ownerId, model) => (model === 'qwen/q' ? { modelId: 'tabby', modelLabel: 'Tabby' } : undefined));

    expect(await bench().idle('u1')).toBe('started');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('u1', { trigger: { kind: 'practice', agent: 'koala', practiceId: 'here' }, scenarioIds: ['koala-cluster'] }, { trialPractice: 'here', modelId: 'tabby', modelLabel: 'Tabby' });
    expect(practices.settle).not.toHaveBeenCalled();
  });

  it('lets a practice for an agent with no scenarios go live, marked unchecked, since there is nothing to check it against', async () => {
    practices.trials.mockResolvedValue([trialItem('p2', { agent: 'planner' })]);
    await bench().idle('u1');
    expect(practices.settle).toHaveBeenCalledWith('u1', 'p2', { checkedAt: NOW_ISO, unchecked: true }, true);
    expect(start.mock.calls[0]![1].trigger).toEqual({ kind: 'full' });
  });

  it('puts a practice live when its trial run breaks nothing, and holds it for the person when something regresses', async () => {
    const trialRun = (regressions: string[]): Level2Run => ({
      id: 'trial-1', ownerId: 'u1', state: 'done', startedAt: 'a', finishedAt: 'b', scenarios: ['koala-cluster'], finished: 1, results: [],
      trigger: { kind: 'practice', agent: 'koala', practiceId: 'p1' }, regressions,
    });

    await bench().finished(trialRun([]));
    await bench().finished(trialRun(['koala-cluster']));
    await bench().finished({ ...trialRun([]), state: 'failed' });

    expect(practices.settle.mock.calls).toEqual([
      ['u1', 'p1', { checkedAt: 'b', runId: 'trial-1', scenarios: ['koala-cluster'], regressions: [], better: [] }, true],
      ['u1', 'p1', { checkedAt: 'b', runId: 'trial-1', scenarios: ['koala-cluster'], regressions: ['koala-cluster'], better: [] }, false],
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('tries a note on a tool on the checks that use the tool, and on the server\'s tools for a note on a server', async () => {
    const note = (id: string, over: Partial<MemoryItem>): MemoryItem => trialItem(id, { category: 'tool_note', ...over });
    notes.trials.mockResolvedValue([note('n1', { tool: 'start_task' }), note('n2', { server: 'playwright' })]);

    expect(await bench().idle('u1')).toBe('started');
    expect(start.mock.calls[0]![1]).toEqual({ trigger: { kind: 'tool-note', about: 'start_task', noteId: 'n1' }, scenarioIds: ['executor-hello'] });

    notes.trials.mockResolvedValue([note('n2', { server: 'playwright' })]);
    await bench().idle('u1');
    expect(start.mock.calls[1]![1]).toEqual({ trigger: { kind: 'tool-note', about: 'the playwright server', noteId: 'n2' }, scenarioIds: ['koala-cluster', 'executor-hello'] });
  });

  it('leaves a note kept for a model it does not serve on trial', async () => {
    notes.trials.mockResolvedValue([trialItem('n4', { category: 'tool_note', tool: 'start_task', model: 'old/model' })]);
    await bench().idle('u1');
    expect(start.mock.calls.map(([, plan]) => plan.trigger.kind)).toEqual(['full']);
    expect(notes.settle).not.toHaveBeenCalled();
  });

  it('holds a note no check uses for the person, and puts one live only when it made a failing check pass and nothing worse', async () => {
    notes.trials.mockResolvedValue([trialItem('n3', { category: 'tool_note', tool: 'search_web' })]);
    await bench().idle('u1');
    expect(start.mock.calls.map(([, plan]) => plan.trigger.kind)).not.toContain('tool-note');
    expect(notes.settle).toHaveBeenCalledWith('u1', 'n3', { checkedAt: NOW_ISO, unchecked: true }, false);

    earlier.mockResolvedValue([{ id: 'before', ownerId: 'u1', state: 'done', startedAt: 'a', scenarios: ['executor-hello'], finished: 1, results: [{ scenarioId: 'executor-hello', passed: false }] } as unknown as Level2Run]);
    await bench().finished({
      id: 'trial-n', ownerId: 'u1', state: 'done', startedAt: 'b', finishedAt: 'c', scenarios: ['executor-hello'], finished: 1,
      results: [{ scenarioId: 'executor-hello', passed: true }] as Level2Run['results'], trigger: { kind: 'tool-note', about: 'start_task', noteId: 'n1' }, regressions: [],
    });
    expect(notes.settle).toHaveBeenLastCalledWith('u1', 'n1', { checkedAt: 'c', runId: 'trial-n', scenarios: ['executor-hello'], regressions: [], better: ['executor-hello'] }, true);
    expect(practices.settle).not.toHaveBeenCalled();

    await bench().finished({
      id: 'trial-m', ownerId: 'u1', state: 'done', startedAt: 'b', finishedAt: 'd', scenarios: ['executor-hello'], finished: 1,
      results: [{ scenarioId: 'executor-hello', passed: false }] as Level2Run['results'], trigger: { kind: 'tool-note', about: 'start_task', noteId: 'n2' }, regressions: [],
    });
    expect(notes.settle).toHaveBeenLastCalledWith('u1', 'n2', { checkedAt: 'd', runId: 'trial-m', scenarios: ['executor-hello'], regressions: [], better: [] }, false);
  });

  it('compares a proposed prompt change on its agent\'s scenarios after any practice trials, and never puts it live itself', async () => {
    scenarios = [{ id: 'koala-cluster', agent: 'koala' }];
    changes.pending.mockResolvedValue([{ id: 'c1', ownerId: 'u1', kind: 'prompt', agent: 'koala', prompt: 'new', currentPrompt: 'old', why: 'w', status: 'proposed', createdAt: 'a' }]);

    expect(await bench().idle('u1')).toBe('started');
    expect(start).toHaveBeenCalledWith('u1', { trigger: { kind: 'prompt-change', agent: 'koala', changeId: 'c1' }, scenarioIds: ['koala-cluster'] }, { promptOverride: { agent: 'koala', prompt: 'new' } });
    expect(changes.comparing).toHaveBeenCalledWith('u1', 'c1');
    expect(changes.settle).not.toHaveBeenCalled();
  });

  it('settles a change for an agent with no scenarios as unchecked and tells the owner', async () => {
    scenarios = [{ id: 'executor-hello', agent: 'executor' }];
    const change: PromptChange = { id: 'c2', ownerId: 'u1', kind: 'prompt', agent: 'planner', prompt: 'new', currentPrompt: 'old', why: 'w', status: 'proposed', createdAt: 'a' };
    changes.pending.mockResolvedValue([change]);
    changes.settle.mockResolvedValue({ ...change, status: 'ready' });

    await bench().idle('u1');

    expect(changes.settle).toHaveBeenCalledWith('u1', 'c2', { checkedAt: NOW_ISO, scenarios: [], better: [], worse: [], unchecked: true });
    expect(notifyChange).toHaveBeenCalledWith('u1', { ...change, status: 'ready' });
    expect(start.mock.calls[0]![1].trigger.kind).toBe('full');
  });

  it('attaches what got better and worse to the change, compared with the latest real runs, and tells the owner it is ready rather than raising a regression', async () => {
    const change: PromptChange = { id: 'c1', ownerId: 'u1', kind: 'prompt', agent: 'koala', prompt: 'new', currentPrompt: 'old', why: 'w', status: 'comparing', createdAt: 'a' };
    earlier.mockResolvedValue([{ id: 'real', ownerId: 'u1', state: 'done', startedAt: '0', scenarios: [], finished: 2, results: [{ scenarioId: 'a', passed: false }, { scenarioId: 'b', passed: true }] as never }]);
    changes.settle.mockResolvedValue({ ...change, status: 'ready' });
    const run = {
      id: 'cmp', ownerId: 'u1', state: 'done', startedAt: '1', finishedAt: '2', scenarios: ['a', 'b'], finished: 2,
      results: [{ scenarioId: 'a', passed: true }, { scenarioId: 'b', passed: false }] as never,
      trigger: { kind: 'prompt-change', agent: 'koala', changeId: 'c1' }, regressions: ['b'],
    } as Level2Run;

    await bench().finished(run);

    expect(changes.settle).toHaveBeenCalledWith('u1', 'c1', { runId: 'cmp', checkedAt: '2', scenarios: [{ scenarioId: 'a', before: false, after: true }, { scenarioId: 'b', before: true, after: false }], better: ['a'], worse: ['b'] });
    expect(notifyChange).toHaveBeenCalledWith('u1', { ...change, status: 'ready' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('settles nothing when a change\'s comparison run did not finish', async () => {
    await bench().finished({ id: 'cmp', ownerId: 'u1', state: 'failed', startedAt: '1', scenarios: [], finished: 0, results: [], trigger: { kind: 'prompt-change', agent: 'koala', changeId: 'c1' } });
    expect(changes.settle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses settings it cannot use, and saves the ones it can, starting the idle countdown when it is on', async () => {
    expect(await bench().saveSettings('u1', { enabled: true, idleMinutes: 0, fullEveryHours: 24 })).toMatchObject({ saved: false });
    expect(await bench().saveSettings('u1', { enabled: true, idleMinutes: 5, fullEveryHours: 12, extra: 'dropped' })).toEqual({ saved: true, settings: { enabled: true, idleMinutes: 5, fullEveryHours: 12 } });
    expect(await bench().settings('u1')).toEqual({ enabled: true, idleMinutes: 5, fullEveryHours: 12 });
    expect(idleTimer.mock.calls).toEqual([['u1', 5 * 60_000]]);
    await bench().saveSettings('u1', { enabled: false, idleMinutes: 5, fullEveryHours: 12 });
    expect(idleTimer).toHaveBeenCalledTimes(1);
  });

  it('starts with the default settings and an empty state for an owner who has set nothing', async () => {
    expect(await bench().settings('u1')).toMatchObject({ idleMinutes: anyOf(Number) });
    expect(await bench().state('u1')).toEqual({ ownerId: 'u1', benched: {} });
  });
});
