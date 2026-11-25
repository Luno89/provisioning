vi.mock('@koala/engine-core/telemetry', async (actual) => ({ ...(await actual<object>()), currentTraceId: () => 'trace-1', currentSpanId: () => 'span-1' }));
import { MockActivityEnvironment } from '@temporalio/testing';
import axios from 'axios';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { toolsOf } from '@koala/agent-engine';
import type { RunEffort } from '@koala/agent-engine/procedure';
import { spaceUser } from '../checks/index.js';
import { CONFLICT_TASK_TITLE } from '../projects/index.js';
import { WORKSPACE_IMAGE_SEEDS } from '../engine/lib/workspace-image-seeds.js';
import type { Scenario, ScenarioExpectations } from '../eval/level2/scenario.js';
import { seededAgents, seededGrants } from '../extensions/seeds.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { interceptHttp } from '../platform/testing/http.js';
import type { Database } from '../platform/lib/db-interface.js';
import {
  createCheckProgressActivity, createCheckRunActivities, failedResult, observedCalls, observedHandOffs, pendingCalls,
  type CheckProgressStore, type CheckReleases, type CheckRunActivities,
} from './CheckRunActivities.js';

const BASE = 'http://koala.test/api';

interface Sent { key: string; method: string; path: string; body: unknown; query: Record<string, string>; cookie: string | null }
interface Reply { status?: number; data?: unknown; headers?: Record<string, string>; bytes?: number }
type Route = Reply | ((sent: Sent) => Reply);

let routes: Record<string, Route> = {};
let sent: Sent[] = [];
let unexpected: string[] = [];

const parsed = (text: string): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

interceptHttp(http.all(`${BASE}/*`, async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api'.length);
  const key = `${request.method} ${path}`;
  const call: Sent = { key, method: request.method, path, body: parsed(await request.text()), query: Object.fromEntries(url.searchParams), cookie: request.headers.get('cookie') };
  sent.push(call);
  const route = routes[key];
  if (!route) {
    unexpected.push(key);
    return HttpResponse.json({ error: `no route for ${key}` }, { status: 500 });
  }
  const reply = typeof route === 'function' ? route(call) : route;
  const status = reply.status ?? 200;
  if (reply.bytes !== undefined) return HttpResponse.arrayBuffer(new ArrayBuffer(reply.bytes), { status, headers: reply.headers ?? { 'content-type': 'image/png' } });
  return HttpResponse.json(reply.data ?? {}, { status, ...(reply.headers ? { headers: reply.headers } : {}) });
}));

const happened = (key: string): Sent[] => sent.filter((call) => call.key === key);

const FINISHED = [{ type: 'run.finished', runId: 'run-1', outcome: 'ok' }];
const TRACES = [{ kind: 'choose-model', outputs: { binding: { model: 'qwen/q' } } }];

const chatRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  'POST /conversations': { data: { id: 'conv-1' } },
  'POST /engine/runs': { data: { runId: 'run-1' } },
  'GET /turns/run-1': { data: { entries: [{ seq: 1, events: [{ type: 'content', runId: 'run-1', delta: 'Hi there' }, ...FINISHED] }] } },
  'GET /conversations/conv-1': { data: { messages: [{ role: 'assistant', content: 'Planned.', runId: 'run-1' }] } },
  'GET /engine/tasks': { data: [] },
  'GET /engine/runs/run-1/traces': { data: { traces: TRACES } },
  ...over,
});

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

const CHAT: Scenario = {
  id: 'chat', name: 'A chat', describe: 'It chats.', agent: 'koala', procedure: { id: 'chat' },
  input: { message: 'Hello' }, expect: { outcome: 'ok' },
};

let db: Database;
let seeded: Record<string, string>;
let terminated: string[];
let signedOut: string[];
let signOutFails: string | undefined;
let released: CheckReleases | undefined;

beforeEach(() => {
  db = memoryDatabase();
  routes = {};
  sent = [];
  unexpected = [];
  seeded = {};
  terminated = [];
  signedOut = [];
  signOutFails = undefined;
  released = undefined;
});

const signedInAs: unknown[] = [];
const spaceIndexed: string[] = [];

const activities = (over: { reported?: boolean; says?: boolean; ownClusterId?: string | undefined } = {}): CheckRunActivities => createCheckRunActivities({
  ownClusterId: () => ('ownClusterId' in over ? over.ownClusterId : 'machine-koala'),
  store: db,
  indexing: { index: async (items) => { spaceIndexed.push(...items.map((item) => item.id)); }, unindex: async () => undefined },
  api: (space, checkRunId) => { signedInAs.push([space, checkRunId]); return axios.create({ baseURL: BASE, headers: { 'x-space': space.id } }); },
  seedFiles: async (_owner, repo, files) => {
    Object.assign(seeded, Object.fromEntries(Object.entries(files).map(([path, content]) => [`${repo}/${path}`, content])));
  },
  reported: async () => over.reported ?? false,
  ...(over.says === undefined ? {} : { says: async () => over.says ?? false }),
  scripted: { base: 'http://localhost:3001/api/checks/scripted', dataKey: 'test-key' as never },
  terminate: async (runId) => {
    terminated.push(runId);
  },
  signOutEverywhere: async (spaceId) => {
    if (signOutFails) throw new Error(signOutFails);
    signedOut.push(spaceId);
  },
  ...(released ? { releases: released } : {}),
  leftovers: { records: async () => ({ users: 1 }), workspaces: async () => ['ws-1'], giteaUser: async () => true },
  pollMs: 1,
  releaseIdleMs: 20,
});

const makeSpace = async (id = 'space-1'): Promise<void> => {
  await db.accounts.saveUser(spaceUser(id, { person: 'bo', checkRunId: 'c1', scenarioId: 'x' }, 't'));
};

const perform = async (scenario: Scenario, over: Record<string, Route> = {}, extra: { modelId?: string; temperature?: number; reported?: boolean; says?: boolean; ownClusterId?: string | undefined } = {}) => {
  routes = chatRoutes(over);
  await makeSpace();
  const { modelId, temperature, ...rest } = extra;
  return activities(rest).CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario, tools: [], ...(modelId ? { modelId } : {}), ...(temperature === undefined ? {} : { temperature }) });
};

const failures = (checks: { what: string; passed: boolean; detail: string }[]) => checks.filter((check) => !check.passed);

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
    { type: 'tool.result', runId: 'r', callId: 'c1', ok: false, digest: 'refused' },
  ];

  it('pairs each call with its result, run by run, even where call ids repeat across runs', () => {
    expect(observedCalls(events)).toEqual([
      { runId: 'r', name: 'research', arguments: '{"question":"a"}', ok: false, digest: 'refused' },
      { runId: 'r', name: 'research', arguments: '{"question":"b"}', ok: true, digest: '' },
      { runId: 'r-research-1', name: 'write_file', arguments: '{}', ok: true, digest: 'wrote 5 bytes' },
    ]);
  });

  it('takes each hand-off from its child run starting and finishing, and counts an unfinished one as running for ever', () => {
    expect(observedHandOffs(events, 'r')).toEqual([
      { agent: 'research', startedAt: Date.parse('2026-10-06T00:00:01.000Z'), finishedAt: Date.parse('2026-10-06T00:00:05.000Z'), outcome: 'ok' },
      { agent: 'research', startedAt: Date.parse('2026-10-06T00:00:02.000Z'), finishedAt: Number.MAX_SAFE_INTEGER, outcome: 'unfinished' },
    ]);
  });

  it('finds the call an approval is waiting on: announced in that run, with no result yet', () => {
    expect(pendingCalls(events, 'r')).toEqual(['c2']);
    expect(pendingCalls(events, 'r-research-1')).toEqual([]);
  });

  it('describes a run that could not start as a failed result carrying the reason', () => {
    const result = failedResult(SCENARIO, 'run-9', 'the space is gone', Date.now() - 50);
    expect(result).toMatchObject({ scenarioId: 'executor-does-one-task', runId: 'run-9', passed: false, outcome: 'failed', reason: 'the space is gone', error: 'the space is gone', checks: [] });
    expect(result.durationMs).toBeGreaterThanOrEqual(50);
  });
});

describe('a check\'s space', () => {
  it('starts with the person\'s own agents and live practices, a practice on trial, a changed prompt, and the scenario\'s world', async () => {
    await db.engine.saveEnginePersona({ slug: 'executor', ownerId: 'bo', prompt: 'mine', name: 'Executor' } as never);
    await db.engine.saveEnginePersona({ slug: 'judge', ownerId: 'cy', prompt: 'not mine', name: 'Judge' } as never);
    await db.memory.saveMemory({ id: 'p1', ownerId: 'bo', title: 'p1', text: 'live', category: 'practice', status: 'active', createdAt: '', updatedAt: '' });
    await db.memory.saveMemory({ id: 'p2', ownerId: 'bo', title: 'p2', text: 'on trial', category: 'practice', status: 'trial', createdAt: '', updatedAt: '' });
    await db.memory.saveMemory({ id: 'm1', ownerId: 'bo', title: 'private', text: 'not copied', category: 'lessons_learned', createdAt: '', updatedAt: '' });
    spaceIndexed.length = 0;

    await activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO, trialPractice: 'p2', promptOverride: { agent: 'koala', prompt: 'proposed' } });

    expect(await db.accounts.getUserById('space-1')).toMatchObject({ email: 'space-1@checks.internal', space: { person: 'bo', checkRunId: 'c1', scenarioId: 'executor-does-one-task' } });
    expect(await db.checks.getBenchSettings('space-1')).toMatchObject({ enabled: false });
    const personas = (await db.engine.getEnginePersonas('space-1')).filter((persona) => persona.ownerId === 'space-1');
    expect(personas.map((persona) => [persona.slug, persona.prompt]).sort()).toEqual([['executor', 'mine']]);
    const memories = (await db.memory.getMemories('space-1')).filter((memory) => memory.ownerId === 'space-1');
    expect(memories.map((memory) => memory.text).sort()).toEqual(['Say hello, not hi.', 'live', 'on trial']);
    expect(spaceIndexed.sort()).toEqual(memories.map((memory) => memory.id).sort());
    expect((await db.projects.getTasks('space-1')).map((task) => [task.id, task.status])).toEqual([['write-greeting', 'accepted']]);
    expect((await db.engine.getProcedures('space-1')).some((procedure) => procedure.id === 'tidy' && procedure.ownerId === 'space-1')).toBe(true);
  });

  it('holds the tools the person granted, and the ones its world grants or takes away, as grants of the space', async () => {
    await db.engine.saveToolGrant({ ownerId: 'bo', agent: 'executor', tool: 'browser', grantedAt: 't' });
    await db.engine.saveToolGrant({ ownerId: 'cy', agent: 'executor', tool: 'other', grantedAt: 't' });

    await activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: { ...SCENARIO, world: { ...SCENARIO.world, agents: { judge: { tools: ['read_file', 'browser'] } } } } });

    const grants = await db.engine.getToolGrants('space-1');
    expect(toolsOf('executor', seededGrants(), grants)).toEqual([...seededAgents().find((agent) => agent.slug === 'executor')!.tools, 'browser']);
    expect(toolsOf('judge', seededGrants(), grants)).toEqual(['read_file', 'browser']);
    expect((await db.engine.getEnginePersonas('space-1')).some((persona) => 'tools' in persona)).toBe(false);
  });

  it('gives an agent its world\'s servers and refuses to change an agent that does not exist', async () => {
    await activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: { ...SCENARIO, world: { agents: { judge: { servers: ['playwright'], model: 'x' } } } } });
    expect((await db.engine.getToolGrants('space-1')).filter((grant) => grant.kind === 'server').map((grant) => [grant.agent, grant.tool])).toEqual([['judge', 'playwright']]);

    await expect(activities().CheckCreateSpaceActivity({ spaceId: 'space-2', checkRunId: 'c2', person: 'bo', scenario: { ...SCENARIO, world: { agents: { nobody: { prompt: 'x' } } } } }))
      .rejects.toThrow('the check\'s world changes the agent "nobody", and there is no such agent');
  });

  it('takes a tree type its world changes only as the Studio would save it', async () => {
    for (const image of WORKSPACE_IMAGE_SEEDS) await db.engine.saveWorkspaceImage(image);
    const odoo = (egress: unknown) => ({ ...SCENARIO, world: { treeTypes: { 'odoo-addons': { egress } } } }) as Scenario;
    await expect(activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: odoo([{ cidr: 'everything' }]) }))
      .rejects.toThrow('the check\'s world changes the tree type "odoo-addons" in a way the Studio would refuse: "everything" is not a valid CIDR');
    await expect(activities().CheckCreateSpaceActivity({ spaceId: 'space-2', checkRunId: 'c2', person: 'bo', scenario: odoo([{ namespace: 'gitea', ports: [3000] }]) }))
      .rejects.toThrow('"gitea" is not one of your apps\' namespaces');
    await activities().CheckCreateSpaceActivity({ spaceId: 'space-3', checkRunId: 'c3', person: 'bo', scenario: odoo([{ cidr: '203.0.113.0/24', ports: [443] }]) });
    expect((await db.projects.getTreeTypes('space-3')).find((type) => type.id === 'odoo-addons')?.egress).toEqual([{ cidr: '203.0.113.0/24', ports: [443] }]);
    await expect(activities().CheckCreateSpaceActivity({ spaceId: 'space-4', checkRunId: 'c4', person: 'bo', scenario: { ...SCENARIO, world: { treeTypes: { 'no-such-type': {} } } } }))
      .rejects.toThrow('the check\'s world changes the tree type "no-such-type", and there is no such type');
  });

  it('is made once, however often the step is retried', async () => {
    const steps = activities();
    await steps.CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO });
    await steps.CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO });
    expect((await db.memory.getMemories('space-1')).filter((memory) => memory.ownerId === 'space-1')).toHaveLength(1);
  });

  it('gets a scripted model of its own, with a key sealed for it', async () => {
    await activities().CheckCreateSpaceActivity({
      spaceId: 'space-1', checkRunId: 'c1', person: 'bo',
      scenario: { ...SCENARIO, script: { rules: [], contextTokens: 4096 } },
    });
    const endpoint = (await db.models.getModelEndpoints()).find((entry) => entry.id === 'scripted-space-1');
    expect(endpoint).toMatchObject({ ownerId: 'space-1', model: 'scripted', baseUrl: 'http://localhost:3001/api/checks/scripted/space-1/v1', contextTokens: 4096 });
    expect(endpoint?.apiKeyEnc).toMatch(/^v2:/);
  });

  it('keeps the person\'s workspace dependencies, tools and tree types and adds the world\'s own tools, dependencies and servers', async () => {
    await db.engine.saveWorkspaceDependency({ name: 'mine', ownerId: 'bo' } as never);
    await activities().CheckCreateSpaceActivity({
      spaceId: 'space-1', checkRunId: 'c1', person: 'bo',
      scenario: {
        ...SCENARIO,
        world: {
          dependencies: [{ name: 'theirs' } as never],
          tools: [{ name: 'greet' } as never],
          mcpServers: [{ name: 'files', runs: { hosted: true } } as never],
        },
      },
    });
    expect((await db.engine.getWorkspaceDependencies('space-1')).map((dependency) => dependency.name).sort()).toEqual(['mine', 'theirs']);
    expect((await db.engine.getEngineTools('space-1')).some((tool) => (tool as { name?: string }).name === 'greet')).toBe(true);
    expect((await db.engine.getMcpServers('space-1')).map((server) => server.id)).toContain('world-files');
  });

  it('stores the procedure that checks one step, and the one that checks a single model turn', async () => {
    await activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: { ...SCENARIO, step: { node: 'text', settings: { text: 'hello' } }, turn: true } });
    const stored = (await db.engine.getProcedures('space-1')).map((procedure) => procedure.id);
    expect(stored).toEqual(expect.arrayContaining(['step-check-executor-does-one-task', 'turn-check']));
  });

  it('refuses a step that is part of how a procedure flows', async () => {
    await expect(activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: { ...SCENARIO, step: { node: 'nothing-like-it' } } }))
      .rejects.toThrow('the step cannot be checked: there is no node called "nothing-like-it"');
  });

  it('copies the person\'s extension settings to the space', async () => {
    await db.engine.saveExtensionSettings({ ownerId: 'bo', disabled: ['grove'] } as never);
    await activities().CheckCreateSpaceActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: SCENARIO });
    expect(await db.engine.getExtensionSettings('space-1')).toMatchObject({ ownerId: 'space-1', disabled: ['grove'] });
  });
});

describe('what a check noticed and what its space left behind', () => {
  it('collects the poisoning signals of every space it was handed', async () => {
    await db.engine.savePoisoningSignal({ id: 's1', ownerId: 'space-1', kind: 'canary', severity: 'high', state: 'open', at: 't', readsKey: 'k', runId: 'r', tool: 'fetch', said: 'a canary left' } as never);
    expect(await activities().CheckNoticedActivity({ spaceIds: ['space-1', 'space-2'] })).toEqual([{ kind: 'canary', said: 'a canary left' }]);
  });

  it('lists what the space left: records, workspaces and its Gitea user', async () => {
    expect(await activities().CheckSpaceGoneActivity({ spaceId: 'space-1' })).toEqual(['1 in users', 'the workspace ws-1', 'its Gitea user']);
  });
});

describe('recording a check run\'s progress', () => {
  it('adds a result once, clears the scenario that was running, and ignores a run that is gone', async () => {
    const store = mock<CheckProgressStore>();
    const record = { results: [] as { scenarioId: string }[], finished: 0, running: 'a' };
    store.getEvalRecord.calledWith('evalScenarioRuns', 'bo', 'c1').mockResolvedValue(record as never);
    const progress = createCheckProgressActivity(store);
    await progress.CheckProgressActivity({ ownerId: 'bo', checkRunId: 'c1', result: { scenarioId: 's1' } as never, running: 'b' });
    expect(store.saveEvalRecord).toHaveBeenCalledWith('evalScenarioRuns', { results: [{ scenarioId: 's1' }], finished: 1, running: 'b' });

    store.getEvalRecord.calledWith('evalScenarioRuns', 'bo', 'c2').mockResolvedValue(null);
    await progress.CheckProgressActivity({ ownerId: 'bo', checkRunId: 'c2' });
    expect(store.saveEvalRecord).toHaveBeenCalledTimes(1);

    const again = { results: [{ scenarioId: 's1' }], finished: 1 };
    store.getEvalRecord.calledWith('evalScenarioRuns', 'bo', 'c3').mockResolvedValue(again as never);
    await progress.CheckProgressActivity({ ownerId: 'bo', checkRunId: 'c3', result: { scenarioId: 's1' } as never });
    expect(store.saveEvalRecord).toHaveBeenLastCalledWith('evalScenarioRuns', { results: [{ scenarioId: 's1' }], finished: 1 });
  });
});

describe('a check run on its space', () => {
  it('reaches the API as the space, with whose space it is, as the check run it belongs to, so it holds its person\'s claim and reaches their clusters', async () => {
    signedInAs.length = 0;
    await perform(CHAT);
    expect(signedInAs[0]).toEqual([{ id: 'space-1', email: expect.any(String) as unknown, space: { person: 'bo' } }, 'c1']);
  });

  it('carries the trace and span it ran under, so where it failed can be read from the trace', async () => {
    const { result } = await perform(CHAT);
    expect(result.trace).toEqual({ traceId: 'trace-1', spanId: 'span-1' });
  });

  it('fails at once, saying so, when the space is gone', async () => {
    routes = chatRoutes();
    const { result, runIds } = await activities().CheckRunScenarioActivity({ spaceId: 'space-9', checkRunId: 'c1', person: 'bo', scenario: CHAT, tools: [] });
    expect(result).toMatchObject({ passed: false, outcome: 'failed', error: 'the check\'s space is gone' });
    expect(runIds).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('starts the chat as the space with the scenario\'s procedure and model, fills the world into the message, and records the run, the model and the answer', async () => {
    await db.engine.saveRunEffort({
      runId: 'run-1', ownerId: 'space-1', agentSlug: 'koala', procedureId: 'chat', procedureVersion: '3', modelKey: 'k', modelLabel: 'l', outcome: 'ok', rounds: 2, toolCalls: 1, totalTokens: 90,
      childRuns: 0, longestReply: 1, cappedAt: 0, steps: 1, wallClockMs: 1, ask: 'a', limits: {} as RunEffort['limits'], finishedAt: 't',
    });
    const { result, runIds } = await perform({ ...CHAT, input: { message: 'Talk in {{world.conversationId}}', inputs: { here: '{{world.conversationId}}' } } }, {}, { modelId: 'qwen/q', temperature: 0.2 });
    expect(unexpected).toEqual([]);
    expect(happened('POST /engine/runs')[0]!.body).toEqual({
      agent: 'koala', message: 'Talk in conv-1', inputs: { here: 'conv-1', conversationId: 'conv-1' }, conversationId: 'conv-1', procedure: 'chat', modelId: 'qwen/q', temperature: 0.2,
    });
    expect(result).toMatchObject({
      runId: 'run-1', conversationId: 'conv-1', passed: true, outcome: 'ok', model: 'qwen/q', answer: 'Planned.',
      procedure: { id: 'chat', version: '3' }, counters: { rounds: 2, toolCalls: 1, totalTokens: 90 },
    });
    expect(runIds).toEqual(['run-1']);
    expect((await db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ conversationId: 'conv-1' });
  });

  it('seeds the world\'s files into the conversation\'s repository and finds the ones the run wrote, wherever the agent put them', async () => {
    routes = chatRoutes({
      'GET /documents/conversation-conv-1': (call) => (call.query.path === 'koala/run-1/out.txt' ? { status: 404 } : call.query.path === 'plain.txt' ? { data: { content: 'Hello World' } } : { status: 404 }),
    });
    await makeSpace();
    const { result } = await activities().CheckRunScenarioActivity({
      spaceId: 'space-1', checkRunId: 'c1', person: 'bo', tools: [],
      scenario: { ...CHAT, world: { files: { 'in.txt': 'data' } }, expect: { outcome: 'ok', files: [{ path: 'plain.txt', contains: ['hello'] }, { path: 'out.txt' }] } },
    });
    expect(Object.keys(seeded)).toEqual(['research-conv-1/in.txt']);
    expect(failures(result.checks).map((check) => check.what)).toEqual(['writes out.txt']);
    expect(result.checks.find((check) => check.what === 'writes plain.txt saying hello')?.passed).toBe(true);
  });

  it('answers a question the run asks, accepts the work it proposed, and allows or refuses the calls it wants to run as the scenario says', async () => {
    const events = [
      { type: 'node.entered', runId: 'run-1', nodeId: 'ask' },
      { type: 'tool.called', runId: 'run-1', callId: 'c1', name: 'run_command', args: '{}' },
      { type: 'notice', runId: 'run-1', level: 'warn', message: 'koala wants to run run_command' },
      { type: 'notice', runId: 'run-1', level: 'warn', message: 'koala wants to run run_command' },
      ...FINISHED,
    ];
    const over: Record<string, Route> = {
      'GET /turns/run-1': { data: { entries: [{ seq: 1, events }] } },
      'GET /engine/tasks': (call) => ({ data: call.query.status === 'proposed' ? [{ id: 'task/1' }] : [] }),
      'POST /engine/runs/run-1/answer': {},
      'POST /engine/tasks/task%2F1/accept': {},
      'POST /engine/runs/run-1/approve': {},
    };
    await perform({ ...CHAT, answers: { ask: 'yes' }, world: { acceptProposedWork: true } }, over);
    expect(happened('POST /engine/runs/run-1/answer').map((call) => call.body)).toEqual([{ nodeId: 'ask', value: 'yes' }]);
    expect(happened('POST /engine/tasks/task%2F1/accept')).toHaveLength(1);
    expect(happened('POST /engine/runs/run-1/approve').map((call) => call.body)).toEqual([{ callId: 'c1', allowed: true }]);

    sent = [];
    await perform({ ...CHAT, approvals: 'refuse' }, over);
    expect(happened('POST /engine/runs/run-1/approve').map((call) => call.body)).toEqual([{ callId: 'c1', allowed: false }]);
  });

  const turnsThen = (second: unknown[], rest: unknown[] = FINISHED): Route => {
    let polls = 0;
    return () => {
      polls += 1;
      return { data: { entries: [{ seq: polls, events: polls === 1 ? FINISHED : polls <= second.length + 1 ? [second[polls - 2]] : rest }] } };
    };
  };
  const said = (delta: string) => ({ type: 'content', runId: 'run-1', delta });

  it('kills a run that has said enough, as a dying worker would, and keeps what it had said marked interrupted', async () => {
    const { result } = await perform(
      { ...CHAT, then: [{ name: 'killed', do: { chat: { message: 'Go', killAfterChars: 2 } }, expect: { interrupted: true } }] },
      {
        'GET /turns/run-1': turnsThen([said('abcdef')], [said('abcdef')]),
        'GET /conversations/conv-1': { data: { messages: [{ role: 'assistant', content: 'abc', runId: 'run-1', interruptedReason: 'killed' }] } },
      },
    );
    expect(terminated).toEqual(['run-1']);
    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.map((check) => check.what)).toContain('killed: keeps what the dead turn had said, marked interrupted');
  });

  it('signs the space out everywhere mid-turn, taking its runs\' access away, and follows the run on with its own access', async () => {
    const { result } = await perform({ ...CHAT, then: [{ name: 'revoked', do: { chat: { message: 'Again', revokeAfterChars: 2 } }, expect: { outcome: 'ok' } }] }, {
      'GET /turns/run-1': turnsThen([said('abcd'), said('efgh')]),
    });
    expect(signedOut).toEqual(['space-1']);
    expect(unexpected).toEqual([]);
    expect(failures(result.checks)).toEqual([]);
  });

  it('stops with the reason when the space could not be signed out', async () => {
    signOutFails = 'the run grants could not be read';
    const revoking: Scenario = { ...CHAT, then: [{ name: 'revoked', do: { chat: { message: 'Again', revokeAfterChars: 2 } }, expect: { outcome: 'ok' } }] };
    const refused = await perform(revoking, { 'GET /turns/run-1': turnsThen([said('abcd')]) });
    expect(refused.result.checks.map((check) => check.detail)).toContain('signing the space out everywhere failed: the run grants could not be read');
  });

  it('fails the stage with the reason when the run would not start', async () => {
    const { result } = await perform(CHAT, { 'POST /engine/runs': { status: 400, data: { error: 'no such agent' } } });
    expect(result).toMatchObject({ passed: false, error: 'the run would not start: no such agent' });
    expect(result.checks).toEqual([{ what: 'runs to the end', passed: false, detail: 'the run would not start: no such agent' }]);
  });

  it('observes the conversation: what the scripted model was sent, whether it summarised, what it kept, and how the run ended', async () => {
    const requests = (count: number): Route => ({ data: { requests: Array.from({ length: count }, (_, index) => ({ text: `request ${index} about pears`, ...(index === 0 ? { rule: 0 } : {}) })) } });
    let model = 0;
    const events = [
      { type: 'notice', runId: 'run-1', message: 'the conversation was summarised into 3 lines' },
      { type: 'content', runId: 'run-1', delta: 'Planned.' },
      ...FINISHED,
    ];
    const { result } = await perform(
      {
        ...CHAT,
        script: { rules: [] },
        expect: {
          modelSaw: { contains: ['pears'], lacks: ['plums'] }, compacted: true, summaryKept: true, interrupted: false,
          ended: { how: 'finished', handover: true }, turnLog: { complete: true },
        },
      },
      {
        'GET /checks/model-requests': () => {
          model += 1;
          return requests(model === 1 ? 0 : 2) as Reply;
        },
        'GET /turns/run-1': { data: { entries: [{ seq: 1, events }] } },
        'GET /conversations/conv-1': { data: { compaction: { through: 4 }, messages: [{ role: 'assistant', content: 'Planned.', runId: 'run-1' }] } },
        'GET /engine/runs/endings': { data: { endings: [{ ended: { how: 'finished' }, handover: { note: 'did it' } }] } },
      },
    );
    expect(unexpected).toEqual([]);
    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining([
      'the model is sent "pears"', 'the model is no longer sent "plums"', 'summarises the conversation', 'the conversation keeps a summary',
      'saves the turn as finished', 'the run ends finished', 'it leaves a handover note', 'the turn log holds the whole turn',
    ]));
  });

  it('observes a step\'s exit and outputs and the tool a single model turn chose', async () => {
    const traces = [
      { node: 'step', exit: 'done', outputs: { text: 'ok then' } },
      { kind: 'call-model', outputs: { reply: { content: '', toolCalls: [{ name: 'list_files', arguments: '{}' }] } } },
    ];
    const { result } = await perform(
      { ...CHAT, expect: { exit: 'done', outputs: { text: { contains: 'ok' } }, chooses: { tool: 'list_files' } } },
      { 'GET /engine/runs/run-1/traces': { data: { traces } } },
    );
    expect(failures(result.checks).map((check) => check.what)).toEqual([]);
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining(['the step leaves by done', 'chooses list_files']));
  });

  it('judges what the run said and the failure it provoked through the checker\'s own judgement', async () => {
    const events = [
      { type: 'tool.called', runId: 'run-1', callId: 'c1', name: 'run_command', args: '{}' },
      { type: 'tool.result', runId: 'run-1', callId: 'c1', ok: false, digest: 'boom' },
      ...FINISHED,
    ];
    const { result } = await perform(
      { ...CHAT, expect: { said: { means: ['says hi'] }, provokes: { tool: 'run_command', when: 'it fails', then: 'reported' } } },
      { 'GET /turns/run-1': { data: { entries: [{ seq: 1, events }] } } },
      { reported: true, says: true },
    );
    expect(result.checks.find((check) => check.what === 'its answer says hi')?.passed).toBe(true);
    expect(result.checks.find((check) => check.what === 'it tells the person what went wrong')?.passed).toBe(true);
    expect(result.calls).toEqual([{ name: 'run_command', ok: false, digest: 'boom' }]);
  });

  it('saves the procedures the first run changed, as the space\'s own', async () => {
    await db.engine.saveProcedure({ id: 'tidy', ownerId: 'space-1', version: '1', source: '{}', updatedAt: 'then' });
    routes = chatRoutes({ 'POST /engine/runs': () => { void db.engine.saveProcedure({ id: 'tidy', ownerId: 'space-1', version: '2', source: '{}', updatedAt: 'now' }); return { data: { runId: 'run-1' } }; } });
    await makeSpace();
    const { result } = await activities().CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', tools: [], scenario: { ...CHAT, expect: { saved: { procedure: 'tidy', stored: false } } } });
    expect(result.checks.find((check) => check.what === 'saves no procedure called tidy')).toMatchObject({ passed: false, detail: 'it saved tidy' });
  });
});

describe('a check\'s world', () => {
  it('captures its MCP servers, waiting until each is ready', async () => {
    let asked = 0;
    const { result } = await perform({ ...CHAT, world: { mcpServers: [{ name: 'files', runs: { hosted: true } } as never] } }, {
      'POST /mcp/catalogue/world-files/capture': { status: 202 },
      'GET /mcp/catalogue/world-files': () => {
        asked += 1;
        return { data: { status: { state: asked < 3 ? 'capturing' : 'captured' } } };
      },
    });
    expect(asked).toBe(3);
    expect(result.outcome).toBe('ok');
  });

  it('stops with the reason when an MCP server cannot be captured', async () => {
    const refused = await perform({ ...CHAT, world: { mcpServers: [{ name: 'files', runs: { hosted: true } } as never] } }, { 'POST /mcp/catalogue/world-files/capture': { status: 400, data: { error: 'bad url' } } });
    expect(refused.result.error).toBe('the world\'s MCP server files could not be captured: bad url');
    const failed = await perform({ ...CHAT, world: { mcpServers: [{ name: 'files', runs: { hosted: true } } as never] } }, {
      'POST /mcp/catalogue/world-files/capture': { status: 202 },
      'GET /mcp/catalogue/world-files': { data: { status: { state: 'failed', why: 'no tools' } } },
    });
    expect(failed.result.error).toBe('the world\'s MCP server files could not be captured: no tools');
  });

  it('makes its project and a second one apart, and opens the conversation in the project', async () => {
    const { result } = await perform({ ...CHAT, world: { project: { name: 'shop' }, apart: { name: 'other' } } }, {
      'POST /projects': (call) => ({ data: { id: (call.body as { name: string }).name.startsWith('shop') ? 'p1' : 'p2', name: (call.body as { name: string }).name, giteaOwner: 'space', giteaRepo: 'r' } }),
    });
    expect(happened('POST /projects').map((call) => call.body)).toEqual([
      { name: 'shop-space-1', giteaRepo: 'shop-space-1', createRepo: true },
      { name: 'other-space-1', giteaRepo: 'other-space-1', createRepo: true },
    ]);
    expect(happened('POST /conversations')[0]!.body).toEqual({ projectId: 'p1' });
    expect((await db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ projectId: 'p1', projectRepo: 'space/r', apartId: 'p2', apartName: 'other-space-1' });
    expect(result.outcome).toBe('ok');
  });

  it('stops with the reason when a project could not be made', async () => {
    const first = await perform({ ...CHAT, world: { project: { name: 'shop' } } }, { 'POST /projects': { status: 400, data: { error: 'taken' } } });
    expect(first.result.error).toBe('the check\'s project could not be made: taken');
    const second = await perform({ ...CHAT, world: { apart: { name: 'other' } } }, { 'POST /projects': { status: 400, data: { error: 'taken' } } });
    expect(second.result.error).toBe('the check\'s second project could not be made: taken');
  });

  it('deploys its apps and waits until each is running, or says it did not', async () => {
    let listed = 0;
    const apps = { 'POST /deployments': { data: { id: 'd1' } } as Reply };
    const ok = await perform({ ...CHAT, world: { apps: [{ name: 'shop', appType: 'wordpress' }] } }, {
      ...apps,
      'GET /deployments': () => {
        listed += 1;
        return { data: [{ id: 'd1', status: listed < 2 ? 'deploying' : 'running', namespace: 'shop-abc' }] };
      },
    });
    expect(happened('POST /deployments')[0]!.body).toEqual({ name: 'shop', clusterId: 'machine-koala', appType: 'wordpress', strategy: 'native' });
    expect((await db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ apps: { shop: 'd1' }, namespaces: { shop: 'shop-abc' } });
    expect(ok.result.outcome).toBe('ok');

    const failed = await perform({ ...CHAT, world: { apps: [{ name: 'shop', appType: 'wordpress' }] } }, { ...apps, 'GET /deployments': { data: [{ id: 'd1', status: 'failed', failure: 'namespaces "shop-abc" not found' }] } });
    expect(failed.result.error).toBe('the world\'s app shop did not deploy: namespaces "shop-abc" not found');
    const unsaid = await perform({ ...CHAT, world: { apps: [{ name: 'shop', appType: 'wordpress' }] } }, { ...apps, 'GET /deployments': { data: [{ id: 'd1', status: 'failed' }] } });
    expect(unsaid.result.error).toBe('the world\'s app shop did not deploy, and its deployment says nothing of why');
    const gone = await perform({ ...CHAT, world: { apps: [{ name: 'shop', appType: 'wordpress' }] } }, { ...apps, 'GET /deployments': { data: [] } });
    expect(gone.result.error).toBe('the world\'s app shop did not deploy: it is gone');
    const nowhere = await perform({ ...CHAT, world: { apps: [{ name: 'shop', appType: 'wordpress' }] } }, apps, { ownClusterId: undefined });
    expect(nowhere.result.error).toBe('the world\'s app shop has no cluster to go on: this Koala runs in no cluster of its own');
    expect(happened('POST /deployments')).toHaveLength(4);
    const refused = await perform({ ...CHAT, world: { apps: [{ name: 'shop', appType: 'wordpress' }] } }, { 'POST /deployments': { status: 400, data: { error: 'no cluster' } } });
    expect(refused.result.error).toBe('the world\'s app shop could not be deployed: no cluster');
  });
});

interface FakeRelease { id: string; state: string; slot?: string; image: string; commit: string; pipelineRunId: string; startedAt: string; reason?: string; e2e?: Record<string, unknown> }

function releasing(options: { builds?: { id: string; status: string; commitSha: string; errorMessage?: string; releaseRefused?: string; startedAt: string }[]; never?: boolean } = {}) {
  const browsed: unknown[] = [];
  let reads = 0;
  let appGone = false;
  const releases: FakeRelease[] = [
    { id: 'rel-a', state: 'live', slot: 'a', image: 'reg/shop:1', commit: 'aaaa1111', pipelineRunId: 'b1', startedAt: '2026-10-08T10:00:00Z' },
    { id: 'rel-b', state: 'preparing', image: 'reg/shop:2', commit: 'bbbb2222', pipelineRunId: 'b2', startedAt: '2026-10-08T11:00:00Z' },
  ];
  const built = options.builds ?? [{ id: 'b2', status: 'succeeded', commitSha: 'bbbb2222', startedAt: '2026-10-08T11:00:00Z' }, { id: 'b1', status: 'succeeded', commitSha: 'aaaa1111', startedAt: '2026-10-08T10:00:00Z' }];
  const table: Record<string, Route> = {
    'POST /projects': { data: { id: 'p1', name: 'odoo-story-space-1', giteaOwner: 'space', giteaRepo: 'odoo-story-space-1' } },
    'GET /projects/p1/releases': () => {
      reads += 1;
      const b = releases[1]!;
      if (!options.never && b.state === 'preparing' && reads > 2) Object.assign(b, { state: 'preview', slot: 'b', e2e: { state: 'running', startedAt: 't' } });
      else if (b.state === 'preview' && (b.e2e as { state: string }).state === 'running' && reads > 4) b.e2e = { state: 'passed', summary: '2 passed, 0 failed', tests: [{ title: 'signs in', status: 'passed' }], startedAt: 't' };
      else if (b.state === 'cutting-over') {
        b.state = 'live';
        releases[0]!.state = 'superseded';
      }
      return { data: { releases: options.never ? [releases[0]] : releases } };
    },
    'GET /projects/p1/runs': { data: built },
    'GET /deployments': () => ({ data: appGone ? [] : [{ id: 'd1', gitappProjectId: 'p1', status: 'running', clusterId: 'c', namespace: 'shop' }] }),
    'GET /artifacts/f1': { bytes: 10 },
    'POST /projects/p1/releases/rel-b/cut-over': () => {
      releases[1]!.state = 'cutting-over';
      return { status: 202 };
    },
    'DELETE /deployments/d1': () => {
      appGone = true;
      return { status: 202 };
    },
  };
  const dependency: CheckReleases = {
    browse: async (args) => {
      browsed.push(args);
      return { state: 'failed', summary: '0 passed, 1 failed', tests: [{ title: 'sees the field live', file: 'live.spec.ts', status: 'failed', durationMs: 900, error: 'toBeVisible() failed' }], artifacts: [{ id: 'f1', name: 'shot.png' }], startedAt: 't', finishedAt: 't' };
    },
    namespaceExists: async () => !appGone,
  };
  return { table, browsed, dependency };
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
  const run = (scenario: Scenario, made: ReturnType<typeof releasing>) => {
    released = made.dependency;
    return perform(scenario, made.table);
  };

  it('waits for the preview and its browser tests, cuts it over, browses the live slot with the check\'s own specs, and removes the app', async () => {
    const made = releasing();
    const { result } = await run(STORY, made);
    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining([
      'preview: the newest release is preview',
      'preview: the preview\'s browser tests end passed',
      'cut over: the newest release is live',
      'browse: the browser tests: "sees the field live" failed',
      'browse: the browser tests keep at least 1 files that open',
      'remove: the project\'s app and its namespace are gone',
    ]));
    expect(made.browsed).toEqual([{ ownerId: 'space-1', projectId: 'p1', release: { slot: 'b', image: 'reg/shop:2', commit: 'bbbb2222' }, specs: { 'e2e/live.spec.ts': 'test()' }, keepUnder: 'run-1' }]);
    expect(happened('POST /projects/p1/releases/rel-b/cut-over')).toHaveLength(1);
    expect(happened('DELETE /deployments/d1')).toHaveLength(1);
  });

  it('releases the project a plan\'s approval made, when the check began with none', async () => {
    const made = releasing();
    made.table['GET /plans'] = { data: [{ id: 'plan-1', status: 'proposed', createdAt: 't' }] };
    made.table['POST /plans/plan-1/approve'] = { status: 202 };
    made.table['GET /plans/plan-1'] = { data: { status: 'adopted', adopted: { treeId: 't9', leafIds: { a: 'l1' } } } };
    made.table['GET /trees'] = { data: [{ id: 't9', projectIds: ['p1'] }] };
    made.table['GET /projects'] = { data: [{ id: 'p1', name: 'Koala shop', giteaOwner: 'space', giteaRepo: 'koala-shop' }] };
    const { result } = await run({ ...STORY, world: undefined, then: [{ name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } }, ...STORY.then!] }, made);
    expect(failures(result.checks)).toEqual([]);
    expect(happened('POST /projects')).toEqual([]);
    expect((await db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ treeId: 't9', projectId: 'p1', projectName: 'Koala shop', projectRepo: 'space/koala-shop', leafIds: { a: 'l1' } });
  });

  it('stops waiting when the build failed, saying why', async () => {
    const made = releasing({ never: true, builds: [{ id: 'b2', status: 'failed', commitSha: 'bbbb2222', errorMessage: 'kaniko: COPY failed', startedAt: '2026-10-08T11:00:00Z' }] });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) }, made);
    expect(result.checks).toContainEqual({ what: 'preview: finishes ok', passed: false, detail: 'it finished failed: the build of bbbb2222 failed: kaniko: COPY failed' });
  });

  it('stops waiting when the build was not released, saying why', async () => {
    const made = releasing({ never: true, builds: [{ id: 'b2', status: 'succeeded', commitSha: 'bbbb2222', releaseRefused: 'the project has no cluster to deploy to', startedAt: '2026-10-08T11:00:00Z' }] });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) }, made);
    expect(result.checks).toContainEqual({ what: 'preview: finishes ok', passed: false, detail: 'it finished failed: the build of bbbb2222 was not released: the project has no cluster to deploy to' });
  });

  it('stops waiting when nothing is building or releasing', async () => {
    const made = releasing({ never: true });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) }, made);
    expect(result.checks.find((check) => check.what === 'preview: finishes ok')?.detail).toBe('it finished failed: nothing is building or releasing, and the newest release is live in slot a; the newest build is succeeded');
  });

  it('waits for a release to go live, and for a build to end', async () => {
    const made = releasing();
    const { result } = await run({
      ...STORY,
      then: [
        { name: 'live', do: { waitRelease: { state: 'live' } }, expect: { outcome: 'ok' } },
        { name: 'built', do: { waitBuild: true }, expect: { outcome: 'ok' } },
      ],
    }, { ...made, table: { ...made.table, 'GET /projects/p1/releases': { data: { releases: [{ id: 'rel-a', state: 'live', slot: 'a', image: 'i', commit: 'c', pipelineRunId: 'b2', startedAt: '2026-10-08T10:00:00Z' }] } } } });
    expect(failures(result.checks)).toEqual([]);
    expect((await db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ releaseId: 'rel-a' });
  });

  it('says what went wrong when a build fails, is held or ends without a release', async () => {
    const made = releasing({ builds: [{ id: 'b3', status: 'failed', commitSha: 'cccc3333', errorMessage: 'no Dockerfile', startedAt: 't' }] });
    const failed = await run({ ...STORY, then: [{ name: 'built', do: { waitBuild: true }, expect: {} }] }, made);
    expect(failed.result.checks).toContainEqual({ what: 'built: finishes ok', passed: false, detail: 'it finished failed: the build of cccc3333 failed: no Dockerfile' });

    const held = releasing({ builds: [{ id: 'b3', status: 'succeeded', commitSha: 'cccc3333', startedAt: 't' }] });
    held.table['GET /projects/p1/runs'] = { data: [{ id: 'b3', status: 'succeeded', commitSha: 'cccc3333', releaseHeld: 'waiting for the client', startedAt: 't' }] };
    held.table['GET /projects/p1/import'] = { data: { import: { state: 'awaited' } } };
    const waiting = await run({ ...STORY, then: [{ name: 'built', do: { waitBuild: true }, expect: { build: { held: true }, clientImport: { state: 'awaited' } } }] }, held);
    expect(failures(waiting.result.checks)).toEqual([]);
    expect(waiting.result.checks.map((check) => check.what)).toEqual(expect.arrayContaining(['built: its build is held', 'built: the client\'s database is awaited']));
  });

  it('refuses to cut over with nothing in preview, and to browse or remove what is not there', async () => {
    const made = releasing({ never: true });
    const { result } = await run({
      ...STORY,
      then: [
        { name: 'cut', do: { cutOver: true }, expect: {} },
        { name: 'browse', do: { browse: { release: 'preview' } }, expect: {} },
      ],
    }, made);
    expect(result.checks.map((check) => check.detail)).toEqual(expect.arrayContaining(['there is no release waiting in preview to cut over']));

    const none = releasing({ never: true });
    none.table['GET /deployments'] = { data: [] };
    const removed = await run({ ...STORY, then: [{ name: 'remove', do: { removeRelease: true }, expect: {} }] }, none);
    expect(removed.result.checks.map((check) => check.detail)).toContain('the project has no app to remove');
  });

  it('reports a cutover that is refused or ends in some other state, and browsing it cannot do without the releases port', async () => {
    const made = releasing();
    made.table['POST /projects/p1/releases/rel-b/cut-over'] = { status: 409, data: { error: 'losing data' } };
    const refused = await run({ ...STORY, then: [STORY.then![0]!, { name: 'cut', do: { cutOver: true }, expect: {} }] }, made);
    expect(refused.result.checks).toContainEqual({ what: 'cut: finishes ok', passed: false, detail: 'it finished failed: the cutover was refused: losing data' });

    released = undefined;
    routes = chatRoutes(releasing().table);
    await makeSpace();
    const noPort = await activities().CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', tools: [], scenario: { ...STORY, then: [STORY.then![0]!, { name: 'browse', do: { browse: { release: 'preview' } }, expect: {} }] } });
    expect(noPort.result.checks.map((check) => check.detail)).toContain('this check runner cannot reach releases to browse them');
  });

  it('reports browser tests that are unavailable and an app that would not be removed', async () => {
    const made = releasing();
    made.dependency.browse = async () => ({ state: 'unavailable', reason: 'no browser here', startedAt: 't', finishedAt: 't' });
    made.table['DELETE /deployments/d1'] = { status: 409, data: { error: 'in use' } };
    const { result } = await run({
      ...STORY,
      then: [STORY.then![0]!, { name: 'browse', do: { browse: { release: 'preview' } }, expect: { e2e: { state: 'unavailable' } } }, { name: 'remove', do: { removeRelease: true }, expect: {} }],
    }, made);
    expect(result.checks.find((check) => check.what === 'browse: the browser tests end unavailable')?.passed).toBe(true);
    expect(result.checks).toContainEqual({ what: 'remove: finishes ok', passed: false, detail: 'it finished failed: the app would not be removed: in use' });
  });

  it('sees a release the app was released into even when the project has none yet', async () => {
    const made = releasing({ never: true });
    made.table['GET /projects/p1/releases'] = { status: 404 };
    made.table['GET /projects/p1/runs'] = { data: [{ id: 'b2', status: 'succeeded', commitSha: 'bbbb2222', releaseSkipped: 'nothing changed', startedAt: 't' }] };
    const { result } = await run({ ...STORY, then: [{ name: 'seen', do: { waitBuild: true }, expect: { release: { exists: true } } }] }, made);
    expect(result.checks.find((check) => check.what === 'seen: the project\'s app is there')?.passed).toBe(true);
  });
});

describe('the actions a check performs on a tree and its project', () => {
  const tree = { 'GET /trees': { data: [{ id: 't1', projectIds: ['p1'] }] } as Reply };
  const planned = (over: Record<string, Route> = {}): Record<string, Route> => ({
    'POST /projects': { data: { id: 'p1', name: 'shop-space-1', giteaOwner: 'space', giteaRepo: 'r' } },
    'GET /plans': { data: [{ id: 'plan-1', status: 'proposed', createdAt: 't' }] },
    'POST /plans/plan-1/approve': { status: 202 },
    'GET /plans/plan-1': { data: { status: 'adopted', adopted: { treeId: 't1', leafIds: { a: 'l1' } } } },
    ...tree,
    'GET /projects': { data: [{ id: 'p1', name: 'shop-space-1', giteaOwner: 'space', giteaRepo: 'r' }] },
    ...over,
  });
  const withTree = (action: Scenario['then'] & {}, over: Record<string, Route> = {}, world: Scenario['world'] = undefined) =>
    perform({ ...CHAT, world, then: [{ name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } }, ...action] }, planned(over));

  it('approves the newest plan waiting, waits for it to be adopted and remembers the tree', async () => {
    const { result } = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } }] }, planned());
    expect(failures(result.checks)).toEqual([]);
    expect((await db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ treeId: 't1', proposalId: 'plan-1', projectId: 'p1' });
  });

  it('approves a plan proposed in a story\'s or feature\'s own chat and remembers what a change made', async () => {
    const { result } = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: { in: { story: 'Ship it' } } }, expect: { outcome: 'ok' } }] }, planned({
      'GET /leaves': { data: [{ id: 'l9', title: 'Ship it' }, { id: 'l8', title: 'Other' }] },
      'POST /items/story/l9/chat': { data: { id: 'story-chat' } },
      'GET /plans': (call) => ({ data: call.query.conversationId === 'story-chat' ? [{ id: 'plan-1', status: 'proposed', createdAt: 't' }, { id: 'old', status: 'adopted', createdAt: 's' }] : [] }),
      'GET /plans/plan-1': { data: { status: 'adopted', change: { kind: 'story' }, adopted: { treeId: 't1', leafIds: { b: 'l2' } } } },
    }));
    expect(failures(result.checks)).toEqual([]);
    expect((await db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ leafIds: { b: 'l2' } });
  });

  it('says when a story or feature is not found exactly once, or a plan is missing, refused, or ends badly', async () => {
    const feature = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: { in: { feature: 'Billing' } } }, expect: {} }] }, planned({ 'GET /branches': { data: [{ id: 'b1', title: 'Billing' }, { id: 'b2', title: 'Billing' }] } }));
    expect(feature.result.checks.map((check) => check.detail)).toContain('more than one feature is called "Billing"');
    const missing = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: { in: { story: 'Nothing' } } }, expect: {} }] }, planned({ 'GET /leaves': { data: [] } }));
    expect(missing.result.checks.map((check) => check.detail)).toContain('no story is called "Nothing"');
    const noChat = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: { in: { story: 'A' } } }, expect: {} }] }, planned({ 'GET /leaves': { data: [{ id: 'l1', title: 'A' }] }, 'POST /items/story/l1/chat': { status: 404, data: { error: 'gone' } } }));
    expect(noChat.result.checks.map((check) => check.detail)).toContain('the story\'s chat could not be opened: gone');

    const none = await withTree([], { 'GET /plans': { data: [{ id: 'p', status: 'adopted', createdAt: 't' }] } });
    expect(none.result.checks.map((check) => check.detail)).toContain('the conversation has no plan waiting to be approved (adopted)');
    const refused = await withTree([], { 'POST /plans/plan-1/approve': { status: 409, data: { error: 'stale' } } });
    expect(refused.result.checks.map((check) => check.detail)).toContain('the plan would not be approved: stale');
    const bad = await withTree([], { 'GET /plans/plan-1': { data: { status: 'failed', reason: 'conflict' } } });
    expect(bad.result.checks.map((check) => check.detail)).toContain('it finished failed: adopting the plan ended failed: conflict');
  });

  it('applies the newest card waiting, and says what happened when it is refused or does not apply', async () => {
    const scenario: Scenario = { ...CHAT, then: [{ name: 'card', do: { applyAction: true }, expect: { outcome: 'ok' } }] };
    const cards: Record<string, Route> = { 'GET /actions': { data: [{ id: 'a1', status: 'proposed', createdAt: '1' }, { id: 'a2', status: 'proposed', createdAt: '2' }] } };
    expect(failures((await perform(scenario, { ...cards, 'POST /actions/a2/apply': { data: { status: 'applied' } } })).result.checks)).toEqual([]);
    const refused = await perform(scenario, { ...cards, 'POST /actions/a2/apply': { status: 400, data: { error: 'stale' } } });
    expect(refused.result.checks).toContainEqual({ what: 'card: finishes ok', passed: false, detail: 'it finished failed: the card would not be applied: stale' });
    const failed = await perform(scenario, { ...cards, 'POST /actions/a2/apply': { data: { status: 'failed', reason: 'no cluster' } } });
    expect(failed.result.checks.map((check) => check.detail)).toContain('it finished failed: applying the card ended failed: no cluster');
    const none = await perform(scenario, { 'GET /actions': { data: [] } });
    expect(none.result.checks.map((check) => check.detail)).toContain('the conversation has no card waiting to be applied');
  });

  it('runs the tree and waits for it to finish or fail', async () => {
    let state = 0;
    const run = (over: Record<string, Route>) => withTree([{ name: 'run', do: { runTree: true }, expect: { outcome: 'ok' } }], { 'POST /trees/t1/run': { status: 202 }, ...over });
    expect(failures((await run({ 'GET /trees/t1/run': () => ({ data: { state: ++state < 3 ? 'running' : 'finished' } }) })).result.checks)).toEqual([]);
    const failed = await run({ 'GET /trees/t1/run': { data: { state: 'failed', reason: 'out of room' } } });
    expect(failed.result.checks.map((check) => check.detail)).toContain('it finished failed: out of room');
    const refused = await run({ 'POST /trees/t1/run': { status: 400, data: { error: 'busy' } } });
    expect(refused.result.checks.map((check) => check.detail)).toContain('the tree would not run: busy');
    const early = await perform({ ...CHAT, then: [{ name: 'run', do: { runTree: true }, expect: {} }] });
    expect(early.result.checks.map((check) => check.detail)).toContain('there is no tree yet: approve a plan in an earlier stage');
  });

  it('waits for every story to settle, or says one waits for a workspace that is stuck', async () => {
    const settle = (leaves: unknown[], growing: string) => withTree([{ name: 'settle', do: { settleTree: true }, expect: { outcome: 'ok' } }], { 'GET /trees/t1/run': { data: { state: growing } }, 'GET /leaves': { data: leaves } });
    expect(failures((await settle([{ title: 'A', status: 'succeeded' }, { title: 'B', status: 'cancelled' }], 'finished')).result.checks)).toEqual([]);
    const stuck = await settle([{ title: 'A', status: 'pending', waitingFor: { stuck: 'declined' } }], 'finished');
    expect(stuck.result.checks.map((check) => check.detail)).toContain('it finished failed: "A" waits for a workspace that is declined');
  });

  it('edits the workspace file and says when the edit changed nothing or would not save', async () => {
    const edit = (over: Route) => withTree([{ name: 'edit', do: { editWorkspace: { packages: ['jq'] } }, expect: { outcome: 'ok' } }], { 'PUT /trees/t1/workspace-file': over });
    expect(failures((await edit({ data: { committed: true } })).result.checks)).toEqual([]);
    const body = happened('PUT /trees/t1/workspace-file')[0]!.body;
    expect(body).toEqual({ file: { packages: ['jq'] }, said: 'a check edits it' });
    expect((await edit({ data: { committed: false } })).result.checks.map((check) => check.detail)).toContain('it finished failed: the edit changed nothing, so nothing was committed');
    expect((await edit({ status: 422, data: { error: 'bad file' } })).result.checks.map((check) => check.detail)).toContain('it finished failed: the workspace file would not save: bad file');
  });

  it('waits until the published workspace has nothing pending, or says it failed', async () => {
    const wait = (view: unknown) => withTree([{ name: 'wait', do: { waitWorkspace: true }, expect: { outcome: 'ok' } }], { 'GET /trees/t1/workspace-file': { data: view } });
    expect(failures((await wait({ pending: [], published: { image: 'i' } })).result.checks)).toEqual([]);
    expect((await wait({ pending: ['jq'], next: { stage: 'failed', text: 'broken' } })).result.checks.map((check) => check.detail)).toContain('it finished failed: the workspace is broken');
  });

  it('waits for the conversation\'s workspace to be released, and for a deleted tree\'s to be gone', async () => {
    let asked = 0;
    const quiet = await perform({ ...CHAT, then: [{ name: 'quiet', do: { waitQuiet: true }, expect: { outcome: 'ok' } }] }, { 'GET /conversations/conv-1/workspace': () => ({ data: { state: ++asked < 2 ? 'ready' : 'none' } }) });
    expect(failures(quiet.result.checks)).toEqual([]);
    const gone = await withTree([{ name: 'delete', do: { deleteTree: true }, expect: { outcome: 'ok' } }], { 'DELETE /trees/t1': {}, 'GET /trees/t1/workspace': { status: 404 } });
    expect(failures(gone.result.checks)).toEqual([]);
    const refused = await withTree([{ name: 'delete', do: { deleteTree: true }, expect: {} }], { 'DELETE /trees/t1': { status: 409, data: { error: 'running' } } });
    expect(refused.result.checks.map((check) => check.detail)).toContain('the tree would not be deleted: running');
  });

  it('posts to the project\'s channel and says when the channel would not open or the post was refused', async () => {
    const world = { project: { name: 'shop' } };
    const post = (over: Record<string, Route>) => perform({ ...CHAT, world, then: [{ name: 'post', do: { post: { message: 'In {{world.conversationId}}', in: 'channel' } }, expect: { outcome: 'ok' } }] }, planned(over));
    expect(failures((await post({ 'GET /projects/p1/channel': { data: { channel: { id: 'chan' } } }, 'POST /conversations/chan/messages': {} })).result.checks)).toEqual([]);
    expect(happened('POST /conversations/chan/messages')[0]!.body).toEqual({ content: 'In conv-1' });
    expect((await post({ 'GET /projects/p1/channel': { data: { channel: { id: 'chan' } } }, 'POST /conversations/chan/messages': { status: 403, data: { error: 'muted' } } })).result.checks.map((check) => check.detail))
      .toContain('it finished failed: the message would not post: muted');
    expect((await post({ 'GET /projects/p1/channel': { status: 404, data: { error: 'no channel' } } })).result.checks.map((check) => check.detail)).toContain('the project\'s channel could not be opened: no channel');
  });

  it('drops code on a story once it is running, and says when it finished first or sits in no project', async () => {
    const drop = (leaf: unknown, over: Record<string, Route> = {}) => withTree([{ name: 'drop', do: { dropOnStory: { story: 'Ship it', files: { 'a.txt': 'x' }, whenRunning: true } }, expect: { outcome: 'ok' } }], {
      'GET /leaves': { data: [leaf] }, 'GET /branches': { data: [{ id: 'b1', treeId: 't1' }] }, 'POST /projects/p1/files/drop': {}, ...over,
    });
    expect(failures((await drop({ id: 'l1', title: 'Ship it', status: 'running', branchId: 'b1' })).result.checks)).toEqual([]);
    expect(happened('POST /projects/p1/files/drop')).toHaveLength(1);
    expect((await drop({ id: 'l1', title: 'Ship it', status: 'succeeded', branchId: 'b1' })).result.checks.map((check) => check.detail)).toContain('it finished failed: "Ship it" was succeeded before anything could be dropped on it');
    expect((await drop({ id: 'l1', title: 'Ship it', status: 'running', branchId: 'b1' }, { 'GET /trees': { data: [{ id: 't1' }] } })).result.checks.map((check) => check.detail))
      .toContain('it finished failed: "Ship it" is in no project, so code cannot be dropped on it');
    expect((await drop({ id: 'l1', title: 'Ship it', status: 'running', branchId: 'b1' }, { 'POST /projects/p1/files/drop': { status: 409, data: { error: 'conflict' } } })).result.checks.map((check) => check.detail))
      .toContain('it finished failed: the drop was refused: conflict');
  });

  it('deletes the project for good by its name and waits until it is gone, or says why it is stuck', async () => {
    const world = { project: { name: 'shop' } };
    const remove = (over: Record<string, Route>) => perform({ ...CHAT, world, then: [{ name: 'delete', do: { deleteProject: true }, expect: { outcome: 'ok' } }] }, planned(over));
    let polled = 0;
    expect(failures((await remove({ 'DELETE /projects/p1': {}, 'GET /projects/p1/removal': () => (++polled < 2 ? { data: { deletion: { phase: 'deleting' } } } : { status: 404 }) })).result.checks)).toEqual([]);
    expect(happened('DELETE /projects/p1')[0]!.body).toEqual({ confirm: 'shop-space-1', mode: 'permanent' });
    expect((await remove({ 'DELETE /projects/p1': {}, 'GET /projects/p1/removal': { data: { deletion: { phase: 'deleting', progress: { problem: 'a cluster is down' } } } } })).result.checks.map((check) => check.detail))
      .toContain('it finished failed: deleting the project is stuck: a cluster is down');
    expect((await remove({ 'DELETE /projects/p1': { status: 409, data: { error: 'busy', blockers: ['an app', 'a build'] } } })).result.checks.map((check) => check.detail))
      .toContain('it finished failed: the project would not be deleted: busy (an app; a build)');
    expect((await perform({ ...CHAT, then: [{ name: 'delete', do: { deleteProject: true }, expect: {} }] })).result.checks.map((check) => check.detail)).toContain('the check has no project to delete');
  });

  it('refuses a stage that no action can do', async () => {
    const { result } = await perform({ ...CHAT, then: [{ name: 'odd', do: { nothing: true } as never, expect: {} }] });
    expect(result.checks.map((check) => check.detail)).toContain('a stage cannot do nothing');
  });
});

describe('what a check observes of the trees, project and apps it made', () => {
  it('reads the stories, the repository, the pull requests, the workspace, the plan and the channel\'s notices', async () => {
    const leaf = { title: 'Ship it', status: 'succeeded', verified: true, landed: { outcome: 'merged' }, findings: 'See [shot](/api/artifacts/00ab-1) for it', attempts: [{}], drops: [{ state: 'merged' }] };
    const expectations: ScenarioExpectations = {
      leaves: { verified: 1, landed: { 'Ship it': 'merged' }, findings: { 'Ship it': ['See'] }, artifacts: { 'Ship it': 1 }, retried: { 'Ship it': 1 }, drops: { 'Ship it': ['merged'] }, mergeTasks: 1 },
      repository: { of: 'tree', files: [{ path: 'src/{{world.treeId}}.txt', contains: ['hi'] }] },
      pullRequests: { merged: 1, open: 1, closedUnmerged: 1 },
      workspace: { of: 'conversation', exists: true },
      plan: { type: 'odoo', version: '20', release: 'slots', startsFrom: 'client-database' },
      noticed: ['released'],
      trees: 1,
      project: { exists: true },
    };
    const { result } = await perform(
      {
        ...CHAT,
        world: { project: { name: 'shop' } },
        then: [
          { name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } },
          { name: 'observe', do: { post: { message: 'hi', in: 'channel' } }, expect: expectations },
        ],
      },
      {
        'POST /projects': { data: { id: 'p1', name: 'shop-space-1', giteaOwner: 'space', giteaRepo: 'r' } },
        'GET /plans': { data: [{ id: 'plan-1', status: 'proposed', createdAt: 't', plan: { tree: { type: 'odoo', version: '20', release: { agent: 'slots' }, startsFrom: 'client-database' } } }] },
        'POST /plans/plan-1/approve': { status: 202 },
        'GET /plans/plan-1': { data: { status: 'adopted', adopted: { treeId: 't1', leafIds: {} } } },
        'GET /trees': { data: [{ id: 't1', projectIds: ['p1'] }] },
        'GET /projects': { data: [] },
        'GET /projects/p1/channel': { data: { channel: { id: 'chan' } } },
        'POST /conversations/chan/messages': {},
        'GET /conversations/chan': { data: { messages: [{ role: 'notice', content: 'The build is released' }, { role: 'user', content: 'hi' }] } },
        'GET /leaves': { data: [leaf] },
        'GET /artifacts/00ab-1': { bytes: 12 },
        'GET /engine/tasks': { data: [{ title: CONFLICT_TASK_TITLE }, { title: 'other' }] },
        'GET /documents/tree-t1': (call) => (call.query.path === 'src/t1.txt' ? { data: { content: 'oh hi' } } : { status: 404 }),
        'GET /trees/t1/pull-requests': { data: { pullRequests: [{ state: 'closed', merged: true }, { state: 'open', merged: false }, { state: 'closed', merged: false }] } },
        'GET /conversations/conv-1/workspace': { data: { state: 'ready' } },
        'GET /projects/p1/removal': { data: {} },
      },
    );
    expect(unexpected).toEqual([]);
    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(15);
  });

  it('reads the alerts set on its apps, the MCP server and who holds it, how builds are released and the models a tree chose', async () => {
    const { result } = await perform(
      {
        ...CHAT,
        world: { project: { name: 'shop' }, apps: [{ name: 'shop', appType: 'wordpress' }] },
        then: [
          { name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } },
          {
            name: 'observe',
            do: { post: { message: 'hi', in: 'channel' } },
            expect: {
              alertRules: [{ app: 'shop', kind: 'down' }],
              mcpServer: { name: 'files', state: 'captured', heldBy: ['executor'] },
              releasedBy: { project: true, agent: 'slots', app: 'odoo' },
              treeModels: { chosen: ['judge'], own: ['executor'] },
            },
          },
          { name: 'type', do: { post: { message: 'again', in: 'channel' } }, expect: { releasedBy: { treeType: 'odoo', agent: 'slots' } } },
        ],
      },
      {
        'POST /projects': { data: { id: 'p1', name: 'shop-space-1', giteaOwner: 'space', giteaRepo: 'r' } },
        'POST /deployments': { data: { id: 'd1' } },
        'GET /deployments': { data: [{ id: 'd1', status: 'running' }] },
        'GET /plans': { data: [{ id: 'plan-1', status: 'proposed', createdAt: 't' }] },
        'POST /plans/plan-1/approve': { status: 202 },
        'GET /plans/plan-1': { data: { status: 'adopted', adopted: { treeId: 't1', leafIds: {} } } },
        'GET /trees': { data: [] },
        'GET /projects': { data: [] },
        'GET /projects/p1/channel': { data: { channel: { id: 'chan' } } },
        'POST /conversations/chan/messages': {},
        'GET /monitoring/alerts': { data: { rules: [{ deploymentId: 'd1', spec: { kind: 'down' } }] } },
        'GET /mcp/catalogue': { data: { servers: [{ name: 'files', status: { state: 'captured' } }] } },
        'GET /agents': { data: { agents: [{ slug: 'executor', servers: ['files'] }, { slug: 'judge' }] } },
        'GET /release-settings/projects/p1': { data: { how: { agent: 'slots', app: 'odoo' }, from: 'type' } },
        'GET /tree-types': { data: [{ id: 'odoo', release: { agent: 'slots' } }] },
        'GET /trees/t1/models': { data: { rows: [{ agent: 'judge', chosen: { modelId: 'qwen/q' } }, { agent: 'executor' }] } },
      },
    );
    expect(unexpected).toEqual([]);
    expect(failures(result.checks)).toEqual([]);
  });

  it('waits for an MCP server being captured to settle before reading it', async () => {
    let reads = 0;
    const { result } = await perform({ ...CHAT, expect: { mcpServer: { name: 'files', state: 'captured' } } }, {
      'GET /mcp/catalogue': () => ({ data: { servers: [{ name: 'files', status: { state: ++reads < 3 ? 'capturing' : 'failed', why: 'no tools' } }] } }),
      'GET /agents': { data: { agents: [] } },
    });
    expect(reads).toBe(3);
    expect(result.checks.find((check) => check.what === 'files is captured')?.detail).toBe('it is failed: no tools');
  });

  it('finds out whether the project is gone and the release still exists', async () => {
    const { result } = await perform({ ...CHAT, world: { project: { name: 'shop' } }, expect: { project: { exists: false } } }, {
      'POST /projects': { data: { id: 'p1', name: 'shop-space-1', giteaOwner: 'space', giteaRepo: 'r' } },
      'GET /projects/p1/removal': { status: 404 },
    });
    expect(failures(result.checks)).toEqual([]);
  });

  it('fails the stage with the reason an observation could not be made', async () => {
    const { result } = await perform({ ...CHAT, expect: { trees: 1 } }, { 'GET /trees': { status: 500, data: { error: 'down' } } });
    expect(result.checks).toEqual([{ what: 'runs to the end', passed: false, detail: 'Request failed with status code 500' }]);
    expect(result.passed).toBe(false);
  });
});

describe('a check run that is cancelled', () => {
  it('stops following the run, cancels it and ends with the cancellation\'s reason', async () => {
    routes = chatRoutes({
      'GET /turns/run-1': { data: { entries: [] } },
      'POST /engine/runs/run-1/cancel': {},
    });
    await makeSpace();
    const env = new MockActivityEnvironment();
    const running = env.run(() => activities().CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: CHAT, tools: [] }));
    const watching = running.catch((error: Error) => error);
    await vi.waitFor(() => expect(happened('GET /turns/run-1').length).toBeGreaterThan(1));
    env.cancel('CANCELLED');
    expect(await watching).toBeInstanceOf(Error);
    expect(happened('POST /engine/runs/run-1/cancel')).toHaveLength(1);
  });

  it('stops waiting for an MCP server to be captured', async () => {
    routes = chatRoutes({
      'POST /mcp/catalogue/world-files/capture': { status: 202 },
      'GET /mcp/catalogue/world-files': { data: { status: { state: 'capturing' } } },
    });
    await makeSpace();
    const env = new MockActivityEnvironment();
    const watching = env.run(() => activities().CheckRunScenarioActivity({
      spaceId: 'space-1', checkRunId: 'c1', person: 'bo', tools: [], scenario: { ...CHAT, world: { mcpServers: [{ name: 'files', runs: { hosted: true } } as never] } },
    })).catch((error: Error) => error);
    await vi.waitFor(() => expect(happened('GET /mcp/catalogue/world-files').length).toBeGreaterThan(1));
    env.cancel('CANCELLED');
    expect(await watching).toBeInstanceOf(Error);
  });

  it('runs outside an activity too, with nothing to cancel', async () => {
    const { result } = await perform(CHAT);
    expect(result.outcome).toBe('ok');
  });
});
