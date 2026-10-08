import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { createCheckRunActivities, observedCalls, observedHandOffs, pendingCalls } from './CheckRunActivities.js';
import type { Scenario } from '../eval/level2/scenario.js';

const SCENARIO: Scenario = {
  id: 'executor-does-one-task',
  name: 'The executor finishes a task',
  describe: 'It should claim the task and record it done.',
  agent: 'executor',
  procedure: { id: 'do-one-task' },
  input: { message: 'Do it.' },
  world: {
    tasks: [{ id: 'write-greeting', title: 'Write the greeting', doneMeans: 'greeting.txt says hello' }],
    memories: [{ title: 'House style', text: 'Say hello, not hi.' }],
    procedures: [{ id: 'tidy', version: '1' } as never],
  },
  expect: { outcome: 'ok' },
};

let db: MemoryDB;

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
});

const activities = () => createCheckRunActivities({
  store: db as never,
  api: () => { throw new Error('not used here'); },
  seedFiles: async () => undefined,
  reported: async () => false,
  scripted: { base: 'http://localhost:3001/api/checks/scripted', dataKey: 'test-key' as never },
  terminate: async () => undefined,
  leftovers: { records: async () => ({}), workspaces: async () => [], giteaUser: async () => false },
});

describe('reading what a run did from its turn log', () => {
  const events = [
    { type: 'run.started', runId: 'r', agentId: 'koala', at: '2026-10-06T00:00:00.000Z' },
    { type: 'tool.called', runId: 'r', callId: 'c1', name: 'research', args: '{"question":"a"}' },
    { type: 'tool.called', runId: 'r', callId: 'c2', name: 'research', args: '{"question":"b"}' },
    { type: 'run.started', runId: 'r-research-1', parentRunId: 'r', agentId: 'research', at: '2026-10-06T00:00:01.000Z' },
    { type: 'run.started', runId: 'r-research-2', parentRunId: 'r', agentId: 'research', at: '2026-10-06T00:00:02.000Z' },
    { type: 'tool.called', runId: 'r-research-1', callId: 'c1', name: 'write_file', args: '{}' },
    { type: 'tool.result', runId: 'r-research-1', callId: 'c1', ok: true, digest: 'wrote 5 bytes' },
    { type: 'run.finished', runId: 'r-research-1', outcome: 'ok', at: '2026-10-06T00:00:05.000Z' },
    { type: 'tool.result', runId: 'r', callId: 'c1', ok: true, digest: 'findings in research/r-research-1/findings.md' },
  ];

  it('pairs each call with its result, run by run, even where call ids repeat across runs', () => {
    expect(observedCalls(events)).toEqual([
      { runId: 'r', name: 'research', arguments: '{"question":"a"}', ok: true, digest: 'findings in research/r-research-1/findings.md' },
      { runId: 'r', name: 'research', arguments: '{"question":"b"}', ok: true, digest: '' },
      { runId: 'r-research-1', name: 'write_file', arguments: '{}', ok: true, digest: 'wrote 5 bytes' },
    ]);
  });

  it('takes each hand-off from its child run starting and finishing', () => {
    expect(observedHandOffs(events, 'r')).toEqual([
      { agent: 'research', startedAt: Date.parse('2026-10-06T00:00:01.000Z'), finishedAt: Date.parse('2026-10-06T00:00:05.000Z'), outcome: 'ok' },
      { agent: 'research', startedAt: Date.parse('2026-10-06T00:00:02.000Z'), finishedAt: Number.MAX_SAFE_INTEGER, outcome: 'unfinished' },
    ]);
  });

  it('finds the call an approval is waiting on: announced in that run, with no result yet', () => {
    expect(pendingCalls(events, 'r')).toEqual(['c2']);
    expect(pendingCalls(events, 'r-research-1')).toEqual([]);
  });
});

describe('a check\'s space', () => {
  it('starts with the person\'s own agents and live practices, a practice on trial, a changed prompt, and the scenario\'s world', async () => {
    await db.saveEnginePersona({ slug: 'executor', ownerId: 'bo', prompt: 'mine', name: 'Executor' } as never);
    await db.saveEnginePersona({ slug: 'judge', ownerId: 'cy', prompt: 'not mine', name: 'Judge' } as never);
    await db.saveMemory({ id: 'p1', ownerId: 'bo', title: 'p1', text: 'live', category: 'practice', status: 'active', createdAt: '', updatedAt: '' });
    await db.saveMemory({ id: 'p2', ownerId: 'bo', title: 'p2', text: 'on trial', category: 'practice', status: 'trial', createdAt: '', updatedAt: '' });
    await db.saveMemory({ id: 'm1', ownerId: 'bo', title: 'private', text: 'not copied', category: 'lessons_learned', createdAt: '', updatedAt: '' });

    await activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO, trialPractice: 'p2', promptOverride: { agent: 'koala', prompt: 'proposed' } });

    expect(await db.getUserById('space-1')).toMatchObject({ email: 'space-1@checks.internal', space: { person: 'bo', checkRunId: 'c1', scenarioId: 'executor-does-one-task' } });
    expect(await db.getBenchSettings('space-1')).toMatchObject({ enabled: false });
    const personas = (await db.getEnginePersonas('space-1')).filter((persona) => persona.ownerId === 'space-1');
    expect(personas.map((persona) => [persona.slug, persona.prompt]).sort()).toEqual([['executor', 'mine']]);
    const memories = (await db.getMemories('space-1')).filter((memory) => memory.ownerId === 'space-1');
    expect(memories.map((memory) => memory.text).sort()).toEqual(['Say hello, not hi.', 'live', 'on trial']);
    expect((await db.getTasks('space-1')).map((task) => [task.id, task.status])).toEqual([['write-greeting', 'accepted']]);
    expect((await db.getProcedures('space-1')).some((procedure) => procedure.id === 'tidy' && procedure.ownerId === 'space-1')).toBe(true);
  });

  it('is made once, however often the step is retried', async () => {
    const steps = activities();
    await steps.CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO });
    await steps.CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO });
    expect((await db.getMemories('space-1')).filter((memory) => memory.ownerId === 'space-1')).toHaveLength(1);
  });
});
