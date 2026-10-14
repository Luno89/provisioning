import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import type { BenchPlan } from '../lib/bench.js';
import { BenchService } from './BenchService.js';
import type { Level2Run } from './Level2Service.js';
import type { MemoryItem, PracticeTrial } from '../lib/memory-store.js';
import type { PromptChange } from '../lib/agent-changes.js';
import type { UserMetadata } from '../lib/types.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();

let db: MemoryDB;
let started: BenchPlan[];
let timers: number[];
let notified: Level2Run[];
let agentsRunning: boolean;
let prints: Record<string, string>;
let trials: MemoryItem[];
let settled: { id: string; trial: PracticeTrial; live: boolean }[];
let pendingChanges: PromptChange[];
let comparing: string[];
let readyChanges: PromptChange[];
let earlierRuns: Level2Run[];
let changeNotices: string[];
let noteTrials: MemoryItem[];
let notesSettled: { id: string; trial: PracticeTrial; live: boolean }[];

const bench = () => new BenchService({
  store: db,
  scenarios: async () => [
    { id: 'koala-cluster', agent: 'koala', tools: ['list_infrastructure', 'playwright__browser_snapshot'] },
    { id: 'executor-hello', agent: 'executor', tools: ['start_task', 'mark_done', 'playwright__browser_click'] },
    { id: 'koala-long-story', agent: 'koala', onBench: false, tools: ['start_task'] },
  ],
  fingerprints: async () => prints,
  practices: { trials: async () => trials, settle: async (_ownerId, id, trial, live) => { settled.push({ id, trial, live }); } },
  notes: { trials: async () => noteTrials, settle: async (_ownerId, id, trial, live) => { notesSettled.push({ id, trial, live }); } },
  changes: {
    pending: async () => pendingChanges,
    comparing: async (_ownerId, id) => { comparing.push(id); },
    settle: async (_ownerId, id, comparison) => { const change = { ...pendingChanges.find((entry) => entry.id === id)!, status: 'ready' as const, comparison }; readyChanges.push(change); return change; },
  },
  earlier: async () => earlierRuns,
  notifyChange: (_ownerId, change) => { changeNotices.push(change.id); },
  start: async (_ownerId, plan) => { started.push(plan); },
  serving: async () => undefined,
  benchRunning: async () => false,
  agentsRunning: async () => agentsRunning,
  idleTimer: async (_ownerId, idleMs) => { timers.push(idleMs); },
  notify: (_ownerId, run) => { notified.push(run); },
  now: () => NOW,
});

const account = (id: string, over: Partial<UserMetadata> = {}) => db.saveUser({ id, email: `${id}@example.com`, emailVerified: true, createdAt: NOW_ISO, ...over } as UserMetadata);

beforeEach(async () => {
  db = new MemoryDB();
  await account('u1');
  started = [];
  timers = [];
  notified = [];
  agentsRunning = false;
  prints = { koala: 'k1', executor: 'e1' };
  trials = [];
  settled = [];
  pendingChanges = [];
  comparing = [];
  readyChanges = [];
  earlierRuns = [];
  changeNotices = [];
  noteTrials = [];
  notesSettled = [];
});

describe('the bench', () => {
  it('restarts its idle countdown whenever a top-level run starts or ends, with the owner\'s idle time', async () => {
    await db.saveBenchSettings('u1', { enabled: true, idleMinutes: 30, fullEveryHours: 24 });

    await bench().activity({ kind: 'run-started', ownerId: 'u1', runId: 'r', agentSlug: 'koala', depth: 0 });
    await bench().activity({ kind: 'run-ended', ownerId: 'u1', runId: 'r', agentSlug: 'koala', outcome: 'ok', ask: 'x', depth: 0 });
    await bench().activity({ kind: 'run-ended', ownerId: 'u1', runId: 'child', agentSlug: 'research', outcome: 'ok', ask: 'x', depth: 1 });

    expect(timers).toEqual([30 * 60_000, 30 * 60_000]);
  });

  it('counts nothing down when it is switched off', async () => {
    await db.saveBenchSettings('u1', { enabled: false, idleMinutes: 30, fullEveryHours: 24 });
    await bench().activity({ kind: 'run-started', ownerId: 'u1', runId: 'r', agentSlug: 'koala', depth: 0 });
    expect(timers).toEqual([]);
  });

  it('counts nothing down for a check\'s space, an account being removed, or one already gone', async () => {
    await account('space-1', { space: { person: 'u1', checkRunId: 'c', scenarioId: 's' } } as Partial<UserMetadata>);
    await account('leaving', { removal: { startedAt: NOW_ISO, requestedBy: 'leaving' } });
    for (const ownerId of ['space-1', 'leaving', 'gone']) {
      await bench().activity({ kind: 'run-ended', ownerId, runId: 'r', agentSlug: 'koala', outcome: 'ok', ask: 'x', depth: 0 });
    }
    expect(timers).toEqual([]);
  });

  it('runs everything the first time the model is idle, then only what changed', async () => {
    expect(await bench().idle('u1')).toBe('started');
    expect(started[0]).toEqual({ trigger: { kind: 'full' }, scenarioIds: ['koala-cluster', 'executor-hello'] });
    expect(await bench().idle('u1')).toBe('nothing');

    prints = { koala: 'k2', executor: 'e1' };
    expect(await bench().idle('u1')).toBe('started');
    expect(started[1]).toEqual({ trigger: { kind: 'changed', agents: ['koala'] }, scenarioIds: ['koala-cluster'] });
    expect(await bench().idle('u1')).toBe('nothing');
  });

  it('waits when an agent is still running, rather than competing with it for the model', async () => {
    agentsRunning = true;
    expect(await bench().idle('u1')).toBe('busy');
    expect(started).toEqual([]);
  });

  it('tells the owner about a run with regressions, and only then', async () => {
    const run = { id: 'run-1', ownerId: 'u1', regressions: ['koala-cluster'] } as Level2Run;
    await bench().finished(run);
    await bench().finished({ ...run, regressions: [] });
    expect(notified).toEqual([run]);
  });

  it('tries a practice on trial first, running only its agent\'s scenarios with it', async () => {
    trials = [{ id: 'p1', ownerId: 'u1', category: 'practice', agent: 'koala', status: 'trial', title: 't', text: 'x', createdAt: 'a', updatedAt: 'a' }];
    const startedWith: (string | undefined)[] = [];
    const service = new BenchService({
      store: db, scenarios: async () => [{ id: 'koala-cluster', agent: 'koala' }, { id: 'executor-hello', agent: 'executor' }], fingerprints: async () => prints,
      practices: { trials: async () => trials, settle: async () => undefined },
      changes: { pending: async () => [], comparing: async () => undefined, settle: async () => undefined },
      earlier: async () => [],
      notifyChange: () => undefined,
      start: async (_ownerId, plan, extra) => { started.push(plan); startedWith.push(extra?.trialPractice); },
      serving: async () => undefined, benchRunning: async () => false, agentsRunning: async () => false, idleTimer: async () => undefined, notify: () => undefined, now: () => NOW,
    });

    expect(await service.idle('u1')).toBe('started');
    expect(started).toEqual([{ trigger: { kind: 'practice', agent: 'koala', practiceId: 'p1' }, scenarioIds: ['koala-cluster'] }]);
    expect(startedWith).toEqual(['p1']);
  });

  it('tries a practice kept for one model on that model, and leaves it on trial while nothing serves that model', async () => {
    trials = [
      { id: 'gone', ownerId: 'u1', category: 'practice', agent: 'koala', model: 'old/model', status: 'trial', title: 't', text: 'x', createdAt: 'a', updatedAt: 'a' },
      { id: 'here', ownerId: 'u1', category: 'practice', agent: 'koala', model: 'qwen/q', status: 'trial', title: 't', text: 'y', createdAt: 'b', updatedAt: 'b' },
    ];
    const startedWith: unknown[] = [];
    const service = new BenchService({
      store: db, scenarios: async () => [{ id: 'koala-cluster', agent: 'koala' }], fingerprints: async () => prints,
      practices: { trials: async () => trials, settle: async (_ownerId, id, trial, live) => { settled.push({ id, trial, live }); } },
      changes: { pending: async () => [], comparing: async () => undefined, settle: async () => undefined },
      earlier: async () => [],
      notifyChange: () => undefined,
      start: async (_ownerId, plan, extra) => { started.push(plan); startedWith.push(extra); },
      serving: async (_ownerId, model) => (model === 'qwen/q' ? { modelId: 'tabby', modelLabel: 'Tabby' } : undefined),
      benchRunning: async () => false, agentsRunning: async () => false, idleTimer: async () => undefined, notify: () => undefined, now: () => NOW,
    });

    expect(await service.idle('u1')).toBe('started');
    expect(started).toEqual([{ trigger: { kind: 'practice', agent: 'koala', practiceId: 'here' }, scenarioIds: ['koala-cluster'] }]);
    expect(startedWith).toEqual([{ trialPractice: 'here', modelId: 'tabby', modelLabel: 'Tabby' }]);
    expect(settled).toEqual([]);
  });

  it('lets a practice for an agent with no scenarios go live, marked unchecked, since there is nothing to check it against', async () => {
    trials = [{ id: 'p2', ownerId: 'u1', category: 'practice', agent: 'planner', status: 'trial', title: 't', text: 'x', createdAt: 'a', updatedAt: 'a' }];
    await bench().idle('u1');
    expect(settled).toEqual([{ id: 'p2', trial: { checkedAt: new Date(NOW).toISOString(), unchecked: true }, live: true }]);
    expect(started[0]!.trigger).toEqual({ kind: 'full' });
  });

  it('puts a practice live when its trial run breaks nothing, and holds it for the person when something regresses', async () => {
    const trialRun = (regressions: string[]): Level2Run => ({
      id: 'trial-1', ownerId: 'u1', state: 'done', startedAt: 'a', finishedAt: 'b', scenarios: ['koala-cluster'], finished: 1, results: [],
      trigger: { kind: 'practice', agent: 'koala', practiceId: 'p1' }, regressions,
    });

    await bench().finished(trialRun([]));
    await bench().finished(trialRun(['koala-cluster']));
    await bench().finished({ ...trialRun([]), state: 'failed' });

    expect(settled).toEqual([
      { id: 'p1', trial: { checkedAt: 'b', runId: 'trial-1', scenarios: ['koala-cluster'], regressions: [], better: [] }, live: true },
      { id: 'p1', trial: { checkedAt: 'b', runId: 'trial-1', scenarios: ['koala-cluster'], regressions: ['koala-cluster'], better: [] }, live: false },
    ]);
    expect(notified).toHaveLength(1);
  });

  it('tries a note on a tool on the checks that use the tool, after any practice, and on the server\'s tools for a note on a server', async () => {
    const note = (id: string, over: Partial<MemoryItem>): MemoryItem => ({ id, ownerId: 'u1', category: 'tool_note', status: 'trial', title: id, text: id, createdAt: id, updatedAt: id, ...over });
    noteTrials = [note('n1', { tool: 'start_task' }), note('n2', { server: 'playwright' })];

    expect(await bench().idle('u1')).toBe('started');
    expect(started).toEqual([{ trigger: { kind: 'tool-note', about: 'start_task', noteId: 'n1' }, scenarioIds: ['executor-hello'] }]);

    noteTrials = [note('n2', { server: 'playwright' })];
    await bench().idle('u1');
    expect(started[1]).toEqual({ trigger: { kind: 'tool-note', about: 'the playwright server', noteId: 'n2' }, scenarioIds: ['koala-cluster', 'executor-hello'] });
  });

  it('holds a note no check uses for the person, and puts one live only when it made a failing check pass and nothing worse', async () => {
    noteTrials = [{ id: 'n3', ownerId: 'u1', category: 'tool_note', status: 'trial', tool: 'search_web', title: 'n3', text: 'n3', createdAt: 'a', updatedAt: 'a' }];
    await bench().idle('u1');
    expect(started.map((plan) => plan.trigger.kind)).not.toContain('tool-note');
    expect(notesSettled).toEqual([{ id: 'n3', trial: { checkedAt: NOW_ISO, unchecked: true }, live: false }]);

    earlierRuns = [{ id: 'before', ownerId: 'u1', state: 'done', startedAt: 'a', scenarios: ['executor-hello'], finished: 1, results: [{ scenarioId: 'executor-hello', passed: false }] } as unknown as Level2Run];
    await bench().finished({
      id: 'trial-n', ownerId: 'u1', state: 'done', startedAt: 'b', finishedAt: 'c', scenarios: ['executor-hello'], finished: 1,
      results: [{ scenarioId: 'executor-hello', passed: true }] as Level2Run['results'], trigger: { kind: 'tool-note', about: 'start_task', noteId: 'n1' }, regressions: [],
    });
    expect(notesSettled[1]).toEqual({ id: 'n1', trial: { checkedAt: 'c', runId: 'trial-n', scenarios: ['executor-hello'], regressions: [], better: ['executor-hello'] }, live: true });
    expect(settled).toEqual([]);

    await bench().finished({
      id: 'trial-m', ownerId: 'u1', state: 'done', startedAt: 'b', finishedAt: 'd', scenarios: ['executor-hello'], finished: 1,
      results: [{ scenarioId: 'executor-hello', passed: false }] as Level2Run['results'], trigger: { kind: 'tool-note', about: 'start_task', noteId: 'n2' }, regressions: [],
    });
    expect(notesSettled[2]).toMatchObject({ id: 'n2', trial: { regressions: [], better: [] }, live: false });
  });

  it('compares a proposed prompt change on its agent\'s scenarios after any practice trials, and never puts it live itself', async () => {
    pendingChanges = [{ id: 'c1', ownerId: 'u1', kind: 'prompt', agent: 'koala', prompt: 'new', currentPrompt: 'old', why: 'w', status: 'proposed', createdAt: 'a' }];
    const extras: unknown[] = [];
    const service = new BenchService({
      store: db, scenarios: async () => [{ id: 'koala-cluster', agent: 'koala' }], fingerprints: async () => ({ koala: 'k1' }),
      practices: { trials: async () => [], settle: async () => undefined },
      changes: { pending: async () => pendingChanges, comparing: async (_o, id) => { comparing.push(id); }, settle: async () => undefined },
      earlier: async () => [], notifyChange: () => undefined,
      start: async (_ownerId, plan, extra) => { started.push(plan); extras.push(extra); },
      serving: async () => undefined, benchRunning: async () => false, agentsRunning: async () => false, idleTimer: async () => undefined, notify: () => undefined, now: () => NOW,
    });

    expect(await service.idle('u1')).toBe('started');
    expect(started).toEqual([{ trigger: { kind: 'prompt-change', agent: 'koala', changeId: 'c1' }, scenarioIds: ['koala-cluster'] }]);
    expect(extras).toEqual([{ promptOverride: { agent: 'koala', prompt: 'new' } }]);
    expect(comparing).toEqual(['c1']);
  });

  it('attaches what got better and worse to the change, compared with the latest real runs, and tells the owner it is ready rather than raising a regression', async () => {
    pendingChanges = [{ id: 'c1', ownerId: 'u1', kind: 'prompt', agent: 'koala', prompt: 'new', currentPrompt: 'old', why: 'w', status: 'comparing', createdAt: 'a' }];
    earlierRuns = [{ id: 'real', ownerId: 'u1', state: 'done', startedAt: '0', scenarios: [], finished: 2, results: [{ scenarioId: 'a', passed: false }, { scenarioId: 'b', passed: true }] as never }];
    const run = {
      id: 'cmp', ownerId: 'u1', state: 'done', startedAt: '1', finishedAt: '2', scenarios: ['a', 'b'], finished: 2,
      results: [{ scenarioId: 'a', passed: true }, { scenarioId: 'b', passed: false }] as never,
      trigger: { kind: 'prompt-change', agent: 'koala', changeId: 'c1' }, regressions: ['b'],
    } as Level2Run;

    await bench().finished(run);

    expect(readyChanges[0]!.comparison).toEqual({ runId: 'cmp', checkedAt: '2', scenarios: [{ scenarioId: 'a', before: false, after: true }, { scenarioId: 'b', before: true, after: false }], better: ['a'], worse: ['b'] });
    expect(changeNotices).toEqual(['c1']);
    expect(notified).toEqual([]);
  });

  it('refuses settings it cannot use, and saves the ones it can', async () => {
    expect(await bench().saveSettings('u1', { enabled: true, idleMinutes: 0, fullEveryHours: 24 })).toMatchObject({ saved: false });
    expect(await bench().saveSettings('u1', { enabled: true, idleMinutes: 5, fullEveryHours: 12, extra: 'dropped' })).toEqual({ saved: true, settings: { enabled: true, idleMinutes: 5, fullEveryHours: 12 } });
    expect(await bench().settings('u1')).toEqual({ enabled: true, idleMinutes: 5, fullEveryHours: 12 });
  });
});
