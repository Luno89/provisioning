import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../platform/lib/memory-db.js';
import { toolsOf } from '@koala/agent-engine';
import { seededAgents, seededGrants } from '../extensions/seeds.js';
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

  it('holds the tools the person granted, and the ones its world grants or takes away, as grants of the space', async () => {
    await db.saveToolGrant({ ownerId: 'bo', agent: 'executor', tool: 'browser', grantedAt: 't' });
    await db.saveToolGrant({ ownerId: 'cy', agent: 'executor', tool: 'other', grantedAt: 't' });

    await activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: { ...SCENARIO, world: { ...SCENARIO.world, agents: { judge: { tools: ['read_file', 'browser'] } } } } });

    const grants = await db.getToolGrants('space-1');
    expect(toolsOf('executor', seededGrants(), grants)).toEqual([...seededAgents().find((agent) => agent.slug === 'executor')!.tools, 'browser']);
    expect(toolsOf('judge', seededGrants(), grants)).toEqual(['read_file', 'browser']);
    expect((await db.getEnginePersonas('space-1')).some((persona) => 'tools' in persona)).toBe(false);
  });

  it('is made once, however often the step is retried', async () => {
    const steps = activities();
    await steps.CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO });
    await steps.CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO });
    expect((await db.getMemories('space-1')).filter((memory) => memory.ownerId === 'space-1')).toHaveLength(1);
  });
});

interface FakeRelease { id: string; state: string; slot?: string; image: string; commit: string; pipelineRunId: string; startedAt: string; reason?: string; e2e?: Record<string, unknown> }

function releasingApi(options: { builds?: { id: string; status: string; commitSha: string; errorMessage?: string; releaseRefused?: string; startedAt: string }[]; never?: boolean } = {}) {
  const calls: string[] = [];
  const browsed: unknown[] = [];
  const made: unknown[] = [];
  let reads = 0;
  let appGone = false;
  const releases: FakeRelease[] = [
    { id: 'rel-a', state: 'live', slot: 'a', image: 'reg/shop:1', commit: 'aaaa1111', pipelineRunId: 'b1', startedAt: '2026-10-08T10:00:00Z' },
    { id: 'rel-b', state: 'preparing', image: 'reg/shop:2', commit: 'bbbb2222', pipelineRunId: 'b2', startedAt: '2026-10-08T11:00:00Z' },
  ];
  const ok = (data: unknown) => ({ status: 200, data, headers: { 'content-type': 'image/png' } });
  const http = {
    async get(path: string) {
      calls.push(`GET ${path}`);
      if (path === '/projects/p1/releases') {
        reads += 1;
        const b = releases[1]!;
        if (!options.never && b.state === 'preparing' && reads > 2) Object.assign(b, { state: 'preview', slot: 'b', e2e: { state: 'running', startedAt: 't' } });
        else if (b.state === 'preview' && (b.e2e as { state: string }).state === 'running' && reads > 4) b.e2e = { state: 'passed', summary: '2 passed, 0 failed', tests: [{ title: 'signs in', status: 'passed' }], startedAt: 't' };
        else if (b.state === 'cutting-over') {
          b.state = 'live';
          releases[0]!.state = 'superseded';
        }
        return ok({ releases: options.never ? [releases[0]] : releases });
      }
      if (path === '/projects/p1/runs') return ok(options.builds ?? [{ id: 'b2', status: 'succeeded', commitSha: 'bbbb2222', startedAt: '2026-10-08T11:00:00Z' }, { id: 'b1', status: 'succeeded', commitSha: 'aaaa1111', startedAt: '2026-10-08T10:00:00Z' }]);
      if (path === '/deployments') return ok(appGone ? [] : [{ id: 'd1', gitappProjectId: 'p1', status: 'running' }]);
      if (path.startsWith('/artifacts/')) return ok(new ArrayBuffer(10));
      if (path === '/turns/run-1') return ok({ entries: [{ seq: 1, events: [{ type: 'run.finished', runId: 'run-1', outcome: 'ok' }] }] });
      if (path === '/engine/runs/run-1/traces') return ok({ traces: [{ kind: 'choose-model', outputs: { binding: { model: 'qwen/q' } } }] });
      if (path === '/conversations/conv-1') return ok({ messages: [{ role: 'assistant', content: 'Planned.', runId: 'run-1' }] });
      if (path === '/engine/tasks') return ok([]);
      if (path === '/plans') return ok([{ id: 'plan-1', status: 'proposed', createdAt: 't' }]);
      if (path === '/plans/plan-1') return ok({ status: 'adopted', adopted: { treeId: 't9', leafIds: {} } });
      if (path === '/trees') return ok([{ id: 't9', projectIds: ['p1'] }]);
      if (path === '/projects') return ok([{ id: 'p1', name: 'Koala shop', giteaOwner: 'space', giteaRepo: 'koala-shop' }]);
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string, body?: unknown) {
      calls.push(`POST ${path}`);
      if (path === '/projects') made.push(body);
      if (path === '/projects') return ok({ id: 'p1', name: 'odoo-story-ce-1', giteaOwner: 'space', giteaRepo: 'odoo-story-ce-1' });
      if (path === '/conversations') return ok({ id: 'conv-1' });
      if (path === '/engine/runs') return ok({ runId: 'run-1' });
      if (path === '/projects/p1/releases/rel-b/cut-over') { releases[1]!.state = 'cutting-over'; return { status: 202, data: {}, headers: {} }; }
      if (path === '/plans/plan-1/approve') return { status: 202, data: {}, headers: {} };
      throw new Error(`unexpected POST ${path}`);
    },
    async delete(path: string) {
      calls.push(`DELETE ${path}`);
      if (path === '/deployments/d1') { appGone = true; return { status: 202, data: {}, headers: {} }; }
      throw new Error(`unexpected DELETE ${path}`);
    },
  };
  const releasesDep = {
    browse: async (args: unknown) => {
      browsed.push(args);
      return { state: 'failed' as const, summary: '0 passed, 1 failed', tests: [{ title: 'sees the field live', file: 'live.spec.ts', status: 'failed' as const, durationMs: 900, error: 'toBeVisible() failed' }], artifacts: [{ id: 'f1', name: 'shot.png' }], startedAt: 't', finishedAt: 't' };
    },
    namespaceExists: async () => !appGone,
  };
  return { http, calls, browsed, made, releasesDep };
}

const STORY: Scenario = {
  id: 'story', name: 'A story', describe: 'releases', agent: 'planner', procedure: { id: 'planning' },
  input: { message: 'Plan it.' },
  world: { project: { name: 'odoo-story' } },
  expect: { outcome: 'ok' },
  then: [
    { name: 'preview', do: { waitRelease: { state: 'preview' } }, expect: { release: { state: 'preview', e2e: { state: 'passed', tests: { 'signs in': 'passed' } } } } },
    { name: 'cut over', do: { cutOver: true }, expect: { release: { state: 'live' } } },
    { name: 'browse', do: { browse: { release: 'live', specs: { 'e2e/live.spec.ts': 'test()' } } }, expect: { e2e: { state: 'failed', tests: { 'sees the field live': 'failed' }, artifacts: 1 } } },
    { name: 'remove', do: { removeRelease: true }, expect: { release: { exists: false } } },
  ],
};

describe('a check that releases its project', () => {
  const run = async (scenario: Scenario, made: ReturnType<typeof releasingApi>) => {
    await db.saveUser({ id: 'space-1', email: 'space-1@checks.internal' } as never);
    return createCheckRunActivities({
      store: db as never,
      api: () => made.http as never,
      seedFiles: async () => undefined,
      reported: async () => false,
      scripted: { base: 'http://localhost:3001/api/checks/scripted', dataKey: 'test-key' as never },
      terminate: async () => undefined,
      leftovers: { records: async () => ({}), workspaces: async () => [], giteaUser: async () => false },
      releases: made.releasesDep,
      pollMs: 1,
      releaseIdleMs: 20,
    }).CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario, tools: [] });
  };

  it('waits for the preview and its browser tests, cuts it over, browses the live slot with the check\'s own specs, and removes the app', async () => {
    const made = releasingApi();
    const { result } = await run(STORY, made);
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    expect(result.model).toBe('qwen/q');
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining([
      'preview: the newest release is preview',
      'preview: the preview\'s browser tests end passed',
      'cut over: the newest release is live',
      'browse: the browser tests: "sees the field live" failed',
      'browse: the browser tests keep at least 1 files that open',
      'remove: the project\'s app and its namespace are gone',
    ]));
    expect(made.browsed).toEqual([{ ownerId: 'space-1', projectId: 'p1', release: { slot: 'b', image: 'reg/shop:2', commit: 'bbbb2222' }, specs: { 'e2e/live.spec.ts': 'test()' }, keepUnder: 'run-1' }]);
    expect(made.calls).toEqual(expect.arrayContaining(['POST /projects/p1/releases/rel-b/cut-over', 'DELETE /deployments/d1']));
    expect(made.made).toEqual([{ name: 'odoo-story-space-1', giteaRepo: 'odoo-story-space-1', createRepo: true }]);
  });

  it('releases the project a plan\'s approval made, when the check began with none', async () => {
    const made = releasingApi();
    const { result } = await run({ ...STORY, world: undefined, then: [{ name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } }, ...STORY.then!] }, made);
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    expect(made.made).toEqual([]);
    expect(made.calls).toEqual(expect.arrayContaining(['POST /plans/plan-1/approve', 'GET /projects/p1/releases', 'POST /projects/p1/releases/rel-b/cut-over']));
  });

  it('stops waiting when the build failed, saying why', async () => {
    const made = releasingApi({ never: true, builds: [{ id: 'b2', status: 'failed', commitSha: 'bbbb2222', errorMessage: 'kaniko: COPY failed', startedAt: '2026-10-08T11:00:00Z' }] });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) }, made);
    expect(result.checks).toContainEqual({ what: 'preview: finishes ok', passed: false, detail: 'it finished failed: the build of bbbb2222 failed: kaniko: COPY failed' });
  });

  it('stops waiting when the build was not released, saying why', async () => {
    const made = releasingApi({ never: true, builds: [{ id: 'b2', status: 'succeeded', commitSha: 'bbbb2222', releaseRefused: 'the project has no cluster to deploy to', startedAt: '2026-10-08T11:00:00Z' }] });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) }, made);
    expect(result.checks).toContainEqual({ what: 'preview: finishes ok', passed: false, detail: 'it finished failed: the build of bbbb2222 was not released: the project has no cluster to deploy to' });
  });

  it('stops waiting when nothing is building or releasing', async () => {
    const made = releasingApi({ never: true });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) }, made);
    expect(result.checks.find((check) => check.what === 'preview: finishes ok')?.detail).toBe('it finished failed: nothing is building or releasing, and the newest release is live in slot a; the newest build is succeeded');
  });
});
