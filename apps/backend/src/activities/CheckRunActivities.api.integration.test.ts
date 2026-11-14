import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { memberSpaceId, spaceUser } from '../checks/index.js';
import type { Scenario } from '../eval/level2/scenario.js';
import type { UserMetadata } from '../platform/lib/types.js';
import { mountCheckApi, type CheckApi } from './testing/check-api.js';
import { itemChatIdFor } from '../engine/index.js';
import { CONFLICT_TASK_TITLE } from '../projects/index.js';
import type { ScenarioExpectations } from '../eval/level2/scenario.js';
import { MockActivityEnvironment } from '@temporalio/testing';
import { channelIdFor } from '../engine/lib/conversations.js';
import { createCheckProgressActivity, createCheckRunActivities, type CheckReleases, type CheckRunActivities } from './CheckRunActivities.js';

const at = '2026-11-02T10:00:00.000Z';

let api: CheckApi;
let seeded: Record<string, string>;
let terminated: string[];
let released: CheckReleases | undefined;
let clients: AxiosInstance[];

beforeEach(async () => {
  api = await mountCheckApi();
  api.ports.workflows.onStart = standardRun;
  seeded = {};
  terminated = [];
  released = undefined;
  clients = [];
});

afterEach(async () => {
  await api.close();
});

const activities = (over: { reported?: boolean; says?: boolean } = {}): CheckRunActivities => createCheckRunActivities({
  ownClusterId: () => 'machine-koala',
  store: api.db,
  api: (space) => {
    const client = api.clientFor(space);
    clients.push(client);
    return client;
  },
  seedFiles: async (_owner, repo, files) => {
    Object.assign(seeded, Object.fromEntries(Object.entries(files).map(([path, content]) => [`${repo}/${path}`, content])));
  },
  reported: async () => over.reported ?? false,
  ...(over.says === undefined ? {} : { says: async () => over.says ?? false }),
  scripted: { base: `${api.baseURL}/checks/scripted`, dataKey: 'test-key' as never },
  terminate: async (runId) => {
    terminated.push(runId);
  },
  ...(released ? { releases: released } : {}),
  leftovers: { records: async () => ({ users: 1 }), workspaces: async () => ['ws-1'], giteaUser: async () => true },
  pollMs: 1,
  releaseIdleMs: 20,
});

const makeSpace = async (id = 'space-1'): Promise<UserMetadata> => {
  const user = spaceUser(id, { person: 'bo', checkRunId: 'c1', scenarioId: 'x' }, at);
  await api.db.accounts.saveUser(user);
  return user;
};

const perform = async (scenario: Scenario, extra: { modelId?: string; temperature?: number; reported?: boolean; says?: boolean } = {}) => {
  await makeSpace();
  const { reported, says, ...rest } = extra;
  return activities({ ...(reported === undefined ? {} : { reported }), ...(says === undefined ? {} : { says }) }).CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario, tools: [], ...rest });
};

const failures = (checks: { what: string; passed: boolean; detail: string }[]) => checks.filter((check) => !check.passed);

const CHAT: Scenario = {
  id: 'chat', name: 'A chat', describe: 'It chats.', agent: 'koala', procedure: { id: 'interactive-chat' },
  input: { message: 'Hello' }, expect: { outcome: 'ok' },
};

const finishing = (runId: string) => ({ type: 'run.finished', runId, outcome: 'ok', at });

const log = async (owner: string, runId: string, seq: number, events: Record<string, unknown>[]) => {
  await api.db.engine.appendTurnLog({ turnId: runId, ownerId: owner, seq, at, events: events as never });
};

async function standardRun({ runId, conversationId, owner }: { runId: string; conversationId: string | undefined; owner: string }): Promise<void> {
  await log(owner, runId, 1, [{ type: 'run.started', runId, at, agentId: 'koala' }, { type: 'content', runId, at, delta: 'Hi there' }, finishing(runId)]);
  await answerChat(owner, conversationId, runId, 'Planned.');
  await traced(owner, runId, 'qwen/q');
}

const answerChat = async (owner: string, conversationId: string | undefined, runId: string, reply: string) => {
  if (!conversationId) return;
  const conversation = await api.db.engine.getConversation(owner, conversationId);
  if (!conversation) return;
  await api.db.engine.saveConversation({ ...conversation, messages: [...conversation.messages, { role: 'assistant', content: reply, runId, at }] });
};

const traced = async (owner: string, runId: string, model: string) => {
  await api.db.engine.saveRunTraces([{ runId, ownerId: owner, agentSlug: 'koala', procedureId: 'interactive-chat', procedureVersion: '5', sequence: 1, kind: 'choose-model', outputs: { binding: { model } } } as never]);
};

describe('a check run that talks to Koala through its real routes', () => {
  it('starts the run on the real run route, follows its turn log, reads the saved answer and the model from the traces', async () => {
    const { result, runIds } = await perform(CHAT, { modelId: 'qwen/q', temperature: 0.2 });

    expect(result).toMatchObject({ passed: true, outcome: 'ok', model: 'qwen/q', answer: 'Planned.' });
    expect(runIds).toHaveLength(1);
    expect(api.ports.workflows.started).toMatchObject([{ type: 'AgentRunWorkflow', owner: 'space-1', conversationId: result.conversationId }]);
    expect(await api.db.engine.ownsRun('space-1', runIds[0]!)).toBe(true);
    expect((await api.db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ conversationId: result.conversationId });
  });

  it('says why the run would not start when the real route refuses the agent', async () => {
    const { result } = await perform({ ...CHAT, agent: 'nobody-by-this-name' });
    expect(result.checks).toEqual([{ what: 'runs to the end', passed: false, detail: expect.stringContaining('the run would not start: ') as string }]);
    expect(api.ports.workflows.started).toEqual([]);
  });

  it('answers a question the run asks and allows the call it wants to run, through the run routes only its owner may use', async () => {
    api.ports.workflows.onStart = async ({ runId, conversationId, owner }) => {
      await log(owner, runId, 1, [
        { type: 'run.started', runId, at, agentId: 'koala' },
        { type: 'node.entered', runId, nodeId: 'ask', at },
        { type: 'tool.called', runId, callId: 'c1', name: 'run_command', args: '{}', at },
        { type: 'notice', runId, level: 'warn', message: 'koala wants to run run_command', at },
        finishing(runId),
      ]);
      await api.db.projects.saveTask({ id: 'task/1', ownerId: owner, title: 'Proposed', doneMeans: 'x', dependsOn: [], status: 'proposed', runs: [], createdAt: at, updatedAt: at } as never);
      await answerChat(owner, conversationId, runId, 'Done.');
      await traced(owner, runId, 'qwen/q');
    };
    const { result } = await perform({ ...CHAT, answers: { ask: 'yes' }, world: { acceptProposedWork: true } });

    expect(failures(result.checks)).toEqual([]);
    expect(api.ports.workflows.signals).toEqual([
      { workflowId: expect.stringContaining('') as string, name: 'answer', payload: { nodeId: 'ask', value: 'yes' } },
      { workflowId: expect.stringContaining('') as string, name: 'approve', payload: { callId: 'c1', allowed: true, forRun: false } },
    ]);
    expect((await api.db.projects.getTasks('space-1')).find((task) => task.id === 'task/1')?.status).toBe('accepted');
  });

  it('refuses the call it is asked about when the scenario says so', async () => {
    api.ports.workflows.onStart = async ({ runId, conversationId, owner }) => {
      await log(owner, runId, 1, [
        { type: 'run.started', runId, at, agentId: 'koala' },
        { type: 'tool.called', runId, callId: 'c1', name: 'run_command', args: '{}', at },
        { type: 'notice', runId, level: 'warn', message: 'koala wants to run run_command', at },
        finishing(runId),
      ]);
      await answerChat(owner, conversationId, runId, 'No.');
      await traced(owner, runId, 'qwen/q');
    };
    await perform({ ...CHAT, approvals: 'refuse' });
    expect(api.ports.workflows.signals.map((signal) => signal.payload)).toEqual([{ callId: 'c1', allowed: false, forRun: false }]);
  });

  it('signs the space out everywhere mid-turn through the real sign-in route and carries on with the session it is given', async () => {
    api.ports.workflows.onStart = async ({ runId, conversationId, owner }) => {
      await log(owner, runId, 1, [{ type: 'run.started', runId, at, agentId: 'koala' }, { type: 'content', runId, at, delta: 'abcd' }]);
      setTimeout(() => {
        void log(owner, runId, 2, [{ type: 'content', runId, at, delta: 'efgh' }, finishing(runId)])
          .then(() => answerChat(owner, conversationId, runId, 'Done.'))
          .then(() => traced(owner, runId, 'qwen/q'));
      }, 100);
    };
    const space = await makeSpace();
    const before = clients.length;
    const { result } = await activities().CheckRunScenarioActivity({
      spaceId: space.id, checkRunId: 'c1', person: 'bo', tools: [],
      scenario: { ...CHAT, then: [{ name: 'revoked', do: { chat: { message: 'Again', revokeAfterChars: 2 } }, expect: { outcome: 'ok' } }] },
    });

    expect(failures(result.checks)).toEqual([]);
    expect((await api.db.accounts.getUserById(space.id))?.sessionsEndedAt).toBeDefined();
    const carried = clients.slice(before)[0]!.defaults.headers.Cookie as string;
    expect(carried).toMatch(/^session=/);
    expect(carried).not.toBe(api.cookieFor(space));
    expect((await clients.slice(before)[0]!.get('/conversations')).status).toBe(200);
  });
});

describe('a check\'s world made through the real routes', () => {
  it('captures its MCP servers through the catalogue route, waiting until each is ready', async () => {
    api.ports.catalogue.recapture.mockResolvedValue({ ok: true, server: { id: 'world-files' } } as never);
    api.ports.catalogue.get
      .mockResolvedValueOnce({ status: { state: 'capturing' } } as never)
      .mockResolvedValueOnce({ status: { state: 'capturing' } } as never)
      .mockResolvedValue({ status: { state: 'captured' } } as never);
    const { result } = await perform({ ...CHAT, world: { mcpServers: [{ name: 'files', runs: { hosted: true } } as never] } });

    expect(api.ports.catalogue.recapture).toHaveBeenCalledWith('space-1', 'world-files');
    expect(api.ports.catalogue.get).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe('ok');
  });

  it('stops with the reason when the catalogue refuses to capture a server, or the capture fails', async () => {
    api.ports.catalogue.recapture.mockResolvedValue({ ok: false, status: 400, error: 'bad url' } as never);
    const world = { mcpServers: [{ name: 'files', runs: { hosted: true } } as never] };
    expect((await perform({ ...CHAT, world })).result.error).toBe('the world\'s MCP server files could not be captured: bad url');

    api.ports.catalogue.recapture.mockResolvedValue({ ok: true, server: {} } as never);
    api.ports.catalogue.get.mockResolvedValue({ status: { state: 'failed', why: 'no tools' } } as never);
    expect((await perform({ ...CHAT, world })).result.error).toBe('the world\'s MCP server files could not be captured: no tools');
  });

  it('makes its project and a second one apart on the real projects route, and opens the conversation in the project', async () => {
    api.ports.repos.createProject.mockImplementation(async (ownerId, input) => {
      const project = { id: input.repo.startsWith('shop') ? 'p1' : 'p2', name: input.name, ownerId, giteaOwner: 'space', giteaRepo: input.repo, appType: 'gitapp' as const, createdAt: at };
      await api.db.projects.saveProject(project as never);
      return project as never;
    });
    const { result } = await perform({ ...CHAT, world: { project: { name: 'shop' }, apart: { name: 'other' } } });

    expect(api.ports.repos.createProject.mock.calls.map(([, input]) => [input.name, input.repo])).toEqual([['shop-space-1', 'shop-space-1'], ['other-space-1', 'other-space-1']]);
    expect((await api.db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ projectId: 'p1', projectRepo: 'space/shop-space-1', apartId: 'p2', apartName: 'other-space-1' });
    expect((await api.db.engine.getConversations()).find((conversation) => conversation.id === result.conversationId)?.projectId).toBe('p1');
    expect(result.outcome).toBe('ok');
  });

  it('stops with the reason when the projects route refuses to make a project', async () => {
    api.ports.repos.createProject.mockRejectedValue(new Error('taken'));
    expect((await perform({ ...CHAT, world: { project: { name: 'shop' } } })).result.error).toBe('the check\'s project could not be made: taken');
    expect((await perform({ ...CHAT, world: { apart: { name: 'other' } } })).result.error).toBe('the check\'s second project could not be made: taken');
  });

  it('deploys its apps through the deployments route and waits until each is running, or says it did not', async () => {
    api.ports.clusters.getById.mockResolvedValue({ id: 'machine-koala' } as never);
    api.ports.bridge.deployApp.mockResolvedValue({ resourceId: 'd1', id: 'wf-1' } as never);
    api.ports.appService.getAll
      .mockResolvedValueOnce([{ id: 'd1', status: 'deploying' }] as never)
      .mockResolvedValue([{ id: 'd1', status: 'running', namespace: 'shop-abc' }] as never);
    const apps = { apps: [{ name: 'shop', appType: 'wordpress' as const }] };
    const ok = await perform({ ...CHAT, world: apps });

    expect(api.ports.bridge.deployApp).toHaveBeenCalledWith({ name: 'shop', clusterId: 'machine-koala', appType: 'wordpress', strategy: 'native' }, 'space-1');
    expect((await api.db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ apps: { shop: 'd1' }, namespaces: { shop: 'shop-abc' } });
    expect(ok.result.outcome).toBe('ok');

    api.ports.appService.getAll.mockResolvedValue([{ id: 'd1', status: 'failed' }] as never);
    expect((await perform({ ...CHAT, world: apps })).result.error).toBe('the world\'s app shop did not deploy');
    api.ports.appService.getAll.mockResolvedValue([] as never);
    expect((await perform({ ...CHAT, world: apps })).result.error).toBe('the world\'s app shop did not deploy: it is gone');
    api.ports.bridge.deployApp.mockRejectedValue(new Error('no cluster'));
    expect((await perform({ ...CHAT, world: apps })).result.error).toBe('the world\'s app shop could not be deployed: no cluster');
  });
});

describe('a check that shares its project through the real routes', () => {
  const shared: Scenario = { ...CHAT, world: { project: { name: 'shop' }, shared: { members: ['client'] } } };
  const member = () => memberSpaceId('space-1', 'client');

  beforeEach(async () => {
    api.ports.repos.createProject.mockImplementation(async (ownerId, input) => {
      const project = { id: 'p1', name: input.name, ownerId, giteaOwner: 'space', giteaRepo: input.repo, appType: 'gitapp' as const, createdAt: at };
      await api.db.projects.saveProject(project as never);
      return project as never;
    });
    api.ports.sharing.share.mockResolvedValue({ ok: true, value: { shared: { hubProjectId: 'h1' } } } as never);
    api.ports.sharing.takeBack.mockResolvedValue({ ok: true, value: { taken: true } } as never);
    api.ports.hub.invite.mockResolvedValue({ ok: true, value: { link: 'http://koala.test/#/join?code=x&project=tok%2F1' } } as never);
    api.ports.hub.accept.mockResolvedValue({ ok: true, value: {} } as never);
    await api.db.accounts.saveUser(spaceUser(member(), { person: 'bo', checkRunId: 'c1', scenarioId: 'x' }, at));
  });

  it('shares the project under a group of its own, invites each member by email and has them join as themselves, then takes the project back', async () => {
    const { result } = await perform(shared);

    expect(api.ports.sharing.share).toHaveBeenCalledWith({ id: 'space-1', email: 'space-1@checks.internal' }, 'p1', 'chkspace1');
    expect(api.ports.hub.invite).toHaveBeenCalledWith(expect.objectContaining({ id: 'space-1' }), 'h1', { email: `${member()}@checks.internal`, role: 'client' });
    expect(api.ports.hub.accept).toHaveBeenCalledWith({ id: member(), email: `${member()}@checks.internal` }, 'tok/1');
    expect(api.ports.sharing.takeBack).toHaveBeenCalledWith('space-1', 'p1', 'shop-space-1');
    expect(result.outcome).toBe('ok');
  });

  it('stops with the reason at each step the real routes refuse', async () => {
    api.ports.sharing.share.mockResolvedValue({ ok: false, status: 400, why: 'no hub' } as never);
    expect((await perform(shared)).result.error).toBe('the check\'s project could not be shared: no hub');
    api.ports.sharing.share.mockResolvedValue({ ok: true, value: { shared: { hubProjectId: 'h1' } } } as never);
    api.ports.hub.invite.mockResolvedValue({ ok: false, status: 400, why: 'full' } as never);
    expect((await perform(shared)).result.error).toBe('the check\'s client could not be invited: full');
    api.ports.hub.invite.mockResolvedValue({ ok: true, value: { link: 'http://koala.test/#/join?code=x&project=tok%2F1' } } as never);
    api.ports.hub.accept.mockResolvedValue({ ok: false, status: 403, why: 'late' } as never);
    expect((await perform(shared)).result.error).toBe('the check\'s client could not join: late');
  });

  it('has a member ask Koala in the shared channel as themselves and follows the run the owner\'s instance starts', async () => {
    api.ports.hub.post.mockImplementation(async (person, _hubId, channelId, body) => {
      const channel = (await api.db.engine.getConversation('space-1', channelId))!;
      await api.db.engine.saveConversation({ ...channel, messages: [
        { role: 'user', content: String(body.content), runId: 'run-9', author: { kind: 'person', id: person.id }, at },
        { role: 'assistant', content: 'It is live.', runId: 'run-9', at },
      ] as never });
      await log('space-1', 'run-9', 1, [{ type: 'run.started', runId: 'run-9', at, agentId: 'koala' }, { type: 'content', runId: 'run-9', at, delta: 'It is live.' }, finishing('run-9')]);
      return { ok: true, value: { asked: { id: 'ask-1' } } } as never;
    });
    const { result } = await perform({ ...shared, then: [{ name: 'ask', do: { memberAsks: { as: 'client', message: 'What is live?' } }, expect: { outcome: 'ok' } }] });

    expect(api.ports.hub.post).toHaveBeenCalledWith({ id: member(), email: `${member()}@checks.internal` }, 'h1', expect.stringContaining('channel') as string, { content: 'What is live?', askKoala: true });
    expect(failures(result.checks)).toEqual([]);
  });

  it('says why when the member\'s ask is refused, was never an ask, or the owner\'s instance refused it', async () => {
    const asking = () => perform({ ...shared, then: [{ name: 'ask', do: { memberAsks: { as: 'client', message: 'Hi' } }, expect: { outcome: 'ok' } }] });
    api.ports.hub.post.mockResolvedValue({ ok: false, status: 403, why: 'read only' } as never);
    expect((await asking()).result.checks.map((check) => check.detail)).toContain('the client\'s message was refused: read only');
    api.ports.hub.post.mockResolvedValue({ ok: true, value: {} } as never);
    expect((await asking()).result.checks.map((check) => check.detail)).toContain('the client\'s message did not ask Koala');
    api.ports.hub.post.mockResolvedValue({ ok: true, value: { asked: { id: 'ask-1' } } } as never);
    api.ports.hub.boardView.mockResolvedValue({ ok: true, value: { requests: [{ id: 'ask-1', state: 'refused', why: 'not yours' }] } } as never);
    expect((await asking()).result.checks.map((check) => check.detail)).toContain('the owner\'s instance refused the client\'s ask: not yours');
  });
});

interface FakeRelease { id: string; state: string; slot?: string; image: string; commit: string; pipelineRunId: string; startedAt: string; reason?: string; e2e?: Record<string, unknown> }

const build = (over: Record<string, unknown>) => ({ id: 'b2', projectId: 'p1', ref: 'main', status: 'succeeded', commitSha: 'bbbb2222', startedAt: '2026-10-08T11:00:00Z', ...over });

async function releasing(options: { builds?: Record<string, unknown>[]; never?: boolean } = {}) {
  await api.db.projects.saveProject({ id: 'p1', name: 'odoo-story-space-1', ownerId: 'space-1', giteaOwner: 'space', giteaRepo: 'odoo-story-space-1', appType: 'gitapp', createdAt: at } as never);
  for (const run of options.builds ?? [build({}), build({ id: 'b1', commitSha: 'aaaa1111', startedAt: '2026-10-08T10:00:00Z' })]) await api.db.releases.savePipelineRun(run as never);
  api.ports.repos.createProject.mockImplementation(async (ownerId) => ({ id: 'p1', name: 'odoo-story-space-1', ownerId, giteaOwner: 'space', giteaRepo: 'odoo-story-space-1', appType: 'gitapp', createdAt: at }) as never);
  const browsed: unknown[] = [];
  let reads = 0;
  let appGone = false;
  const releases: FakeRelease[] = [
    { id: 'rel-a', state: 'live', slot: 'a', image: 'reg/shop:1', commit: 'aaaa1111', pipelineRunId: 'b1', startedAt: '2026-10-08T10:00:00Z' },
    { id: 'rel-b', state: 'preparing', image: 'reg/shop:2', commit: 'bbbb2222', pipelineRunId: 'b2', startedAt: '2026-10-08T11:00:00Z' },
  ];
  api.ports.releases.list.mockImplementation(async () => {
    reads += 1;
    const b = releases[1]!;
    if (!options.never && b.state === 'preparing' && reads > 2) Object.assign(b, { state: 'preview', slot: 'b', e2e: { state: 'running', startedAt: 't' } });
    else if (b.state === 'preview' && (b.e2e as { state: string }).state === 'running' && reads > 4) b.e2e = { state: 'passed', summary: '2 passed, 0 failed', tests: [{ title: 'signs in', status: 'passed' }], startedAt: 't' };
    else if (b.state === 'cutting-over') {
      b.state = 'live';
      releases[0]!.state = 'superseded';
    }
    return (options.never ? [releases[0]] : releases) as never;
  });
  api.ports.releases.addresses.mockResolvedValue({} as never);
  api.ports.releases.rollBackOffer.mockResolvedValue(undefined as never);
  api.ports.releases.decide.mockImplementation(async () => {
    releases[1]!.state = 'cutting-over';
    return releases[1] as never;
  });
  api.ports.appService.getAll.mockImplementation(async () => (appGone ? [] : [{ id: 'd1', gitappProjectId: 'p1', status: 'running', clusterId: 'c', namespace: 'shop' }]) as never);
  api.ports.appService.getById.mockImplementation(async () => ({ id: 'd1', status: 'running' }) as never);
  api.ports.bridge.destroyApp.mockImplementation(async () => {
    appGone = true;
    return { id: 'wf-destroy' } as never;
  });
  api.ports.artifacts.get.mockImplementation(async () => ({ artifact: { id: 'f1', ownerId: 'space-1', runId: 'r1', name: 'shot.png', contentType: 'image/png', size: 10, createdAt: 'now' }, body: Readable.from([Buffer.alloc(10, 1)]) }));
  released = {
    browse: async (args) => {
      browsed.push(args);
      return { state: 'failed', summary: '0 passed, 1 failed', tests: [{ title: 'sees the field live', file: 'live.spec.ts', status: 'failed', durationMs: 900, error: 'toBeVisible() failed' }], artifacts: [{ id: 'f1', name: 'shot.png' }], startedAt: 't', finishedAt: 't' };
    },
    namespaceExists: async () => !appGone,
  };
  return { browsed, releases };
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

describe('a check that releases its project through the real routes', () => {
  const run = async (scenario: Scenario) => {
    await makeSpace();
    return activities().CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario, tools: [] });
  };

  it('waits for the preview and its browser tests, cuts it over, browses the live slot, opens its artifacts and removes the app', async () => {
    const made = await releasing();
    const { result } = await run(STORY);

    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining([
      'preview: the newest release is preview',
      'cut over: the newest release is live',
      'browse: the browser tests: "sees the field live" failed',
      'browse: the browser tests keep at least 1 files that open',
      'remove: the project\'s app and its namespace are gone',
    ]));
    expect(api.ports.releases.decide).toHaveBeenCalledWith('space-1', 'rel-b', 'cutOver', false);
    expect(api.ports.bridge.destroyApp).toHaveBeenCalledWith('d1');
    expect(api.ports.artifacts.get).toHaveBeenCalledWith('space-1', 'f1');
    expect(made.browsed).toEqual([{ ownerId: 'space-1', projectId: 'p1', release: { slot: 'b', image: 'reg/shop:2', commit: 'bbbb2222' }, specs: { 'e2e/live.spec.ts': 'test()' }, keepUnder: expect.stringContaining('run-') as string }]);
  });

  it('stops waiting when the build failed, saying why', async () => {
    await releasing({ never: true, builds: [build({ status: 'failed', errorMessage: 'kaniko: COPY failed' })] });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) });
    expect(result.checks).toContainEqual({ what: 'preview: finishes ok', passed: false, detail: 'it finished failed: the build of bbbb2222 failed: kaniko: COPY failed' });
  });

  it('stops waiting when the build was not released, saying why', async () => {
    await releasing({ never: true, builds: [build({ releaseRefused: 'the project has no cluster to deploy to' })] });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) });
    expect(result.checks).toContainEqual({ what: 'preview: finishes ok', passed: false, detail: 'it finished failed: the build of bbbb2222 was not released: the project has no cluster to deploy to' });
  });

  it('stops waiting when nothing is building or releasing', async () => {
    await releasing({ never: true });
    const { result } = await run({ ...STORY, then: STORY.then!.slice(0, 1) });
    expect(result.checks.find((check) => check.what === 'preview: finishes ok')?.detail).toBe('it finished failed: nothing is building or releasing, and the newest release is live in slot a; the newest build is succeeded');
  });

  it('waits for a build to end, and says it was held, when asked to wait for a build', async () => {
    await releasing({ builds: [build({ releaseHeld: 'waiting for the client\'s database' })] });
    const { result } = await run({ ...STORY, then: [{ name: 'built', do: { waitBuild: true }, expect: { build: { held: true } } }] });
    expect(failures(result.checks)).toEqual([]);
  });

  it('reports a cutover the release route refuses', async () => {
    await releasing();
    api.ports.releases.decide.mockResolvedValue({ error: 'it would lose data', status: 409 } as never);
    const { result } = await run({ ...STORY, then: [STORY.then![0]!, STORY.then![1]!] });
    expect(result.checks).toContainEqual({ what: 'cut over: finishes ok', passed: false, detail: 'it finished failed: the cutover was refused: it would lose data' });
  });

  it('reports an app the deployments route would not remove', async () => {
    await releasing();
    api.ports.appService.getById.mockResolvedValue(undefined as never);
    const { result } = await run({ ...STORY, then: [{ name: 'remove', do: { removeRelease: true }, expect: { release: { exists: false } } }] });
    expect(result.checks).toContainEqual({ what: 'remove: finishes ok', passed: false, detail: 'it finished failed: the app would not be removed: Deployment not found' });
  });
});

describe('the actions a check performs on a tree and its project through the real routes', () => {
  const PLAN = { tree: { name: 'Shop', type: 'odoo', version: '20', release: { agent: 'slots' }, startsFrom: 'client-database' }, planDoc: '# Shop', branches: [] };

  const proposal = (over: Record<string, unknown> = {}) => ({ id: 'plan-1', ownerId: 'space-1', status: 'proposed', plan: PLAN, createdAt: '2026-11-02T10:00:00.000Z', updatedAt: at, ...over });

  const seedTree = async (leafStatus = 'running') => {
    await api.db.projects.saveProject({ id: 'p1', name: 'shop-space-1', ownerId: 'space-1', giteaOwner: 'space', giteaRepo: 'r', appType: 'gitapp', createdAt: at } as never);
    await api.db.projects.saveTree({ id: 't1', ownerId: 'space-1', name: 'Shop', type: 'odoo', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
    await api.db.projects.saveBranch({ id: 'b1', ownerId: 'space-1', treeId: 't1', title: 'Billing', createdAt: at, updatedAt: at });
    await api.db.projects.saveLeaf({ id: 'l1', ownerId: 'space-1', branchId: 'b1', title: 'Ship it', status: leafStatus } as never);
  };

  const planning = (decide: (proposalId: string) => Promise<void> = async () => undefined, plan: Record<string, unknown> = {}) => {
    api.ports.workflows.onStart = async (started) => {
      await standardRun(started);
      await api.db.projects.savePlanProposal(proposal({ conversationId: started.conversationId, ...plan }) as never);
    };
    api.ports.adopter.adoptPlan.mockImplementation(async (ownerId, id) => {
      setTimeout(() => { void decide(id); }, 40);
      return `adopt-${ownerId}-${id}`;
    });
  };

  const adopted = (treeId = 't1', leafIds: Record<string, string> = { a: 'l1' }, more: Record<string, unknown> = {}) => async (id: string) => {
    const found = await api.db.projects.getPlanProposal('space-1', id);
    await api.db.projects.savePlanProposal({ ...found!, status: 'adopted', adopted: { treeId, leafIds }, ...more } as never);
  };

  const withTree = async (action: NonNullable<Scenario['then']>, world: Scenario['world'] = undefined, decide = adopted()) => {
    await seedTree();
    planning(decide);
    return perform({ ...CHAT, world, then: [{ name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } }, ...action] });
  };

  it('approves the newest plan waiting through the real plans route, waits for it to be adopted and remembers the tree and its project', async () => {
    const { result } = await withTree([]);

    expect(failures(result.checks)).toEqual([]);
    expect(api.ports.adopter.adoptPlan).toHaveBeenCalledWith('space-1', 'plan-1');
    expect((await api.db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ treeId: 't1', proposalId: 'plan-1', projectId: 'p1', projectName: 'shop-space-1', projectRepo: 'space/r' });
  });

  it('approves a plan proposed in a story\'s own chat, opened on the real item chat route, and remembers what a change made', async () => {
    await seedTree();
    const chatId = itemChatIdFor({ kind: 'story', leafId: 'l1' });
    api.ports.workflows.onStart = standardRun;
    api.ports.adopter.adoptPlan.mockImplementation(async (_owner, id) => {
      setTimeout(() => { void adopted('t1', { b: 'l2' }, { change: { kind: 'story' } })(id); }, 40);
      return 'adopt-1';
    });
    await api.db.projects.savePlanProposal(proposal({ conversationId: chatId }) as never);
    await api.db.projects.savePlanProposal(proposal({ id: 'old', status: 'adopted', conversationId: chatId, createdAt: '2026-11-01T10:00:00.000Z' }) as never);
    const { result } = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: { in: { story: 'Ship it' } } }, expect: { outcome: 'ok' } }] });

    expect(failures(result.checks)).toEqual([]);
    expect((await api.db.engine.getConversation('space-1', chatId))?.kind).toBe('item');
    expect((await api.db.accounts.getUserById('space-1'))?.space?.world).toMatchObject({ leafIds: { b: 'l2' } });
  });

  it('says when a story or feature is not found exactly once, or its chat will not open', async () => {
    await seedTree();
    await api.db.projects.saveBranch({ id: 'b2', ownerId: 'space-1', treeId: 't1', title: 'Billing', createdAt: at, updatedAt: at });
    const approvingIn = (place: { story: string } | { feature: string }) => perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: { in: place } }, expect: {} }] });
    expect((await approvingIn({ feature: 'Billing' })).result.checks.map((check) => check.detail)).toContain('more than one feature is called "Billing"');
    expect((await approvingIn({ story: 'Nothing' })).result.checks.map((check) => check.detail)).toContain('no story is called "Nothing"');
    await api.db.projects.saveLeaf({ id: 'l9', ownerId: 'space-1', branchId: 'gone', title: 'Orphan', status: 'pending' } as never);
    expect((await approvingIn({ story: 'Orphan' })).result.checks.map((check) => check.detail)).toContain('the story\'s chat could not be opened: No such story');
  });

  it('says when no plan waits, the approval is refused, or the adoption ends badly', async () => {
    await seedTree();
    planning(async () => undefined, { status: 'adopted' });
    const none = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: true }, expect: {} }] });
    expect(none.result.checks.map((check) => check.detail)).toContain('the conversation has no plan waiting to be approved (adopted)');

    planning();
    api.ports.adopter.adoptPlan.mockResolvedValue(undefined);
    const refused = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: true }, expect: {} }] });
    expect(refused.result.checks.map((check) => check.detail).join(' ')).toContain('the plan would not be approved: ');

    planning(async (id) => {
      const found = await api.db.projects.getPlanProposal('space-1', id);
      await api.db.projects.savePlanProposal({ ...found!, status: 'failed', reason: 'conflict' } as never);
    });
    const bad = await perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: true }, expect: {} }] });
    expect(bad.result.checks.map((check) => check.detail)).toContain('it finished failed: adopting the plan ended failed: conflict');
  });

  it('applies the newest card waiting on the real actions route, and says what happened when it is refused or does not apply', async () => {
    const scenario: Scenario = { ...CHAT, then: [{ name: 'card', do: { applyAction: true }, expect: { outcome: 'ok' } }] };
    api.ports.actions.list.mockResolvedValue([{ id: 'a1', status: 'proposed', createdAt: '1' }, { id: 'a2', status: 'proposed', createdAt: '2' }] as never);
    api.ports.actions.apply.mockResolvedValue({ ok: true, proposal: { status: 'applied' } } as never);
    expect(failures((await perform(scenario)).result.checks)).toEqual([]);
    expect(api.ports.actions.apply).toHaveBeenCalledWith('space-1', 'a2', expect.objectContaining({ claims: expect.anything() as unknown }));

    api.ports.actions.apply.mockResolvedValue({ ok: false, status: 400, error: 'stale' } as never);
    expect((await perform(scenario)).result.checks).toContainEqual({ what: 'card: finishes ok', passed: false, detail: 'it finished failed: the card would not be applied: stale' });
    api.ports.actions.apply.mockResolvedValue({ ok: true, proposal: { status: 'failed', reason: 'no cluster' } } as never);
    expect((await perform(scenario)).result.checks.map((check) => check.detail)).toContain('it finished failed: applying the card ended failed: no cluster');
    api.ports.actions.list.mockResolvedValue([] as never);
    expect((await perform(scenario)).result.checks.map((check) => check.detail)).toContain('the conversation has no card waiting to be applied');
  });

  it('runs the tree on the real trees route and waits for it to finish or fail', async () => {
    const run = () => withTree([{ name: 'run', do: { runTree: true }, expect: { outcome: 'ok' } }]);
    api.ports.groveRuns.run.mockResolvedValue({ ok: true, value: {} } as never);
    api.ports.groveRuns.status
      .mockResolvedValueOnce({ ok: true, value: { state: 'running' } } as never)
      .mockResolvedValue({ ok: true, value: { state: 'finished' } } as never);
    expect(failures((await run()).result.checks)).toEqual([]);
    expect(api.ports.groveRuns.run).toHaveBeenCalledWith('space-1', 't1');

    api.ports.groveRuns.status.mockResolvedValue({ ok: true, value: { state: 'failed', reason: 'out of room' } } as never);
    expect((await run()).result.checks.map((check) => check.detail)).toContain('it finished failed: out of room');
    api.ports.groveRuns.run.mockResolvedValue({ ok: false, status: 400, error: 'busy' } as never);
    expect((await run()).result.checks.map((check) => check.detail)).toContain('the tree would not run: busy');
    expect((await perform({ ...CHAT, then: [{ name: 'run', do: { runTree: true }, expect: {} }] })).result.checks.map((check) => check.detail)).toContain('there is no tree yet: approve a plan in an earlier stage');
  });

  it('waits for every story to settle on the real leaves route, or says one waits for a workspace that is stuck', async () => {
    api.ports.groveRuns.status.mockResolvedValue({ ok: true, value: { state: 'finished' } } as never);
    const settle = async (stories: Record<string, unknown>[]) => {
      await seedTree('succeeded');
      for (const story of stories) await api.db.projects.saveLeaf({ ownerId: 'space-1', branchId: 'b1', ...story } as never);
      planning(adopted());
      return perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: true }, expect: {} }, { name: 'settle', do: { settleTree: true }, expect: { outcome: 'ok' } }] });
    };
    const settled = await settle([{ id: 'l2', title: 'Other', status: 'cancelled' }]);
    expect(failures(settled.result.checks)).toEqual([]);

    const stuck = await settle([{ id: 'l1', title: 'Ship it', status: 'pending', waitingFor: { reason: 'a package', since: at, stuck: 'declined' } }]);
    expect(stuck.result.checks.map((check) => check.detail)).toContain('it finished failed: "Ship it" waits for a workspace that is declined');
  });

  it('edits the workspace file through the real route and says when the edit changed nothing or would not save', async () => {
    const edit = () => withTree([{ name: 'edit', do: { editWorkspace: { packages: ['jq'] } }, expect: { outcome: 'ok' } }]);
    api.ports.treeWorkspaceFile.save.mockResolvedValue({ ok: true, view: { pending: [] }, committed: true } as never);
    expect(failures((await edit()).result.checks)).toEqual([]);
    expect(api.ports.treeWorkspaceFile.save).toHaveBeenCalledWith('space-1', 't1', { packages: ['jq'] }, 'a check edits it');
    api.ports.treeWorkspaceFile.save.mockResolvedValue({ ok: true, view: { pending: [] }, committed: false } as never);
    expect((await edit()).result.checks.map((check) => check.detail)).toContain('it finished failed: the edit changed nothing, so nothing was committed');
    api.ports.treeWorkspaceFile.save.mockResolvedValue({ ok: false, status: 422, why: 'bad file' } as never);
    expect((await edit()).result.checks.map((check) => check.detail)).toContain('it finished failed: the workspace file would not save: bad file');
  });

  it('waits until the published workspace has nothing pending, or says it failed', async () => {
    const wait = () => withTree([{ name: 'wait', do: { waitWorkspace: true }, expect: { outcome: 'ok' } }]);
    api.ports.treeWorkspaceFile.view.mockResolvedValue({ pending: [], published: { image: 'i' } } as never);
    expect(failures((await wait()).result.checks)).toEqual([]);
    api.ports.treeWorkspaceFile.view.mockResolvedValue({ pending: ['jq'], next: { stage: 'failed', text: 'broken' } } as never);
    expect((await wait()).result.checks.map((check) => check.detail)).toContain('it finished failed: the workspace is broken');
  });

  it('waits for the conversation\'s workspace to be released, and for a deleted tree\'s to be gone', async () => {
    api.ports.workspaceState.conversation = 'running';
    setTimeout(() => { api.ports.workspaceState.conversation = 'none'; }, 30);
    const quiet = await perform({ ...CHAT, then: [{ name: 'quiet', do: { waitQuiet: true }, expect: { outcome: 'ok' } }] });
    expect(failures(quiet.result.checks)).toEqual([]);

    api.ports.groveDeletion.deleteTree.mockResolvedValue({ ok: true, value: { stoppedRun: false, scope: {} } } as never);
    api.ports.treeWorkspaces.state.mockResolvedValue('none' as never);
    const gone = await withTree([{ name: 'delete', do: { deleteTree: true }, expect: { outcome: 'ok' } }]);
    expect(failures(gone.result.checks)).toEqual([]);
    expect(api.ports.groveDeletion.deleteTree).toHaveBeenCalledWith('space-1', 't1');

    api.ports.groveDeletion.deleteTree.mockResolvedValue({ ok: false, status: 409, error: 'running' } as never);
    const refused = await withTree([{ name: 'delete', do: { deleteTree: true }, expect: {} }]);
    expect(refused.result.checks.map((check) => check.detail)).toContain('the tree would not be deleted: running');
  });

  it('posts to the project\'s channel on the real conversations route, and says when the post is refused', async () => {
    const world = { project: { name: 'shop' } };
    api.ports.repos.createProject.mockImplementation(async (ownerId, input) => {
      const project = { id: 'p1', name: input.name, ownerId, giteaOwner: 'space', giteaRepo: input.repo, appType: 'gitapp' as const, createdAt: at };
      await api.db.projects.saveProject(project as never);
      return project as never;
    });
    const post = (message: string, scenario: Partial<Scenario> = {}) => perform({ ...CHAT, world, then: [{ name: 'post', do: { post: { message, in: 'channel' } }, expect: { outcome: 'ok' } }], ...scenario });
    expect(failures((await post('In {{world.conversationId}}')).result.checks)).toEqual([]);
    const channel = (await api.db.engine.getConversations()).find((conversation) => conversation.kind === 'channel')!;
    expect(channel.messages.map((message) => [message.role, message.content])).toEqual([['user', expect.stringMatching(/^In /) as string]]);

    expect((await post('   ')).result.checks.map((check) => check.detail).join(' ')).toContain('the message would not post: ');
  });

  it('drops code on a story once it is running, and says when it finished first or sits in no project', async () => {
    api.ports.storyDrops.drop.mockResolvedValue({ ok: true } as never);
    const drop = (status: string, over: { tree?: boolean } = {}) => async () => {
      await seedTree(status);
      if (over.tree === false) await api.db.projects.saveTree({ id: 't1', ownerId: 'space-1', name: 'Shop', type: 'odoo', createdAt: at, updatedAt: at } as never);
      planning(adopted());
      return perform({ ...CHAT, then: [{ name: 'approve', do: { approvePlan: true }, expect: {} }, { name: 'drop', do: { dropOnStory: { story: 'Ship it', files: { 'a.txt': 'x' }, whenRunning: true } }, expect: { outcome: 'ok' } }] });
    };
    expect(failures((await drop('running')()).result.checks)).toEqual([]);
    expect(api.ports.storyDrops.drop).toHaveBeenCalledWith('space-1', 'p1', 'l1', [{ path: 'a.txt', size: 1, source: expect.any(String) as string }], undefined);
    expect((await drop('succeeded')()).result.checks.map((check) => check.detail)).toContain('it finished failed: "Ship it" was succeeded before anything could be dropped on it');
    expect((await drop('running', { tree: false })()).result.checks.map((check) => check.detail)).toContain('it finished failed: "Ship it" is in no project, so code cannot be dropped on it');
    api.ports.storyDrops.drop.mockResolvedValue({ ok: false, status: 409, why: 'conflict' } as never);
    expect((await drop('running')()).result.checks.map((check) => check.detail)).toContain('it finished failed: the drop was refused: conflict');
  });

  it('deletes the project by its name on the real projects route and waits for its removal to finish, or says why it stopped', async () => {
    const world = { project: { name: 'shop' } };
    api.ports.repos.createProject.mockImplementation(async (ownerId, input) => {
      const project = { id: 'p1', name: input.name, ownerId, giteaOwner: 'space', giteaRepo: input.repo, appType: 'gitapp' as const, createdAt: at };
      await api.db.projects.saveProject(project as never);
      return project as never;
    });
    const remove = () => perform({ ...CHAT, world, then: [{ name: 'delete', do: { deleteProject: true }, expect: { outcome: 'ok' } }] });
    api.ports.removal.remove.mockResolvedValue({ ok: true, state: { state: 'running' } } as never);
    api.ports.removal.preview
      .mockResolvedValueOnce({ state: { state: 'running' } } as never)
      .mockResolvedValue(undefined as never);
    expect(failures((await remove()).result.checks)).toEqual([]);
    expect(api.ports.removal.remove).toHaveBeenCalledWith('space-1', 'p1', 'shop-space-1');

    api.ports.removal.preview.mockResolvedValue({ state: { state: 'failed', reason: 'a cluster is down' } } as never);
    expect((await remove()).result.checks.map((check) => check.detail)).toContain('it finished failed: deleting the project stopped: a cluster is down');
    api.ports.removal.remove.mockResolvedValue({ ok: false, refusal: { status: 409, error: 'busy', blockers: ['an app', 'a build'] } } as never);
    expect((await remove()).result.checks.map((check) => check.detail)).toContain('it finished failed: the project would not be deleted: busy (an app; a build)');
    expect((await perform({ ...CHAT, then: [{ name: 'delete', do: { deleteProject: true }, expect: {} }] })).result.checks.map((check) => check.detail)).toContain('the check has no project to delete');
  });

  it('refuses a stage that no action can do', async () => {
    const { result } = await perform({ ...CHAT, then: [{ name: 'odd', do: { nothing: true } as never, expect: {} }] });
    expect(result.checks.map((check) => check.detail)).toContain('a stage cannot do nothing');
  });
});

describe('what a check observes of its run, through the real routes', () => {
  it('observes the conversation: what the scripted model was sent, whether it summarised, what it kept, and how the run ended', async () => {
    let asked = 0;
    api.ports.scripted.requests.mockImplementation(async () => {
      asked += 1;
      return Array.from({ length: asked === 1 ? 0 : 2 }, (_, index) => ({ text: `request ${index} about pears`, ...(index === 0 ? { rule: 0 } : {}) })) as never;
    });
    api.ports.workflows.onStart = async ({ runId, conversationId, owner }) => {
      await log(owner, runId, 1, [
        { type: 'run.started', runId, at, agentId: 'koala' },
        { type: 'notice', runId, level: 'info', message: 'the conversation was summarised into 3 lines', at },
        { type: 'content', runId, at, delta: 'Planned.' },
        finishing(runId),
      ]);
      const conversation = (await api.db.engine.getConversation(owner, conversationId!))!;
      await api.db.engine.saveConversation({ ...conversation, compaction: { summary: 'earlier', through: 4 }, messages: [{ role: 'assistant', content: 'Planned.', runId, at }] });
      await api.db.engine.saveRunEnded({ runId, ownerId: owner, ended: { how: 'finished', at }, handover: { note: 'did it' } });
      await traced(owner, runId, 'qwen/q');
    };
    const { result } = await perform({
      ...CHAT,
      script: { rules: [] },
      expect: {
        modelSaw: { contains: ['pears'], lacks: ['plums'] }, compacted: true, summaryKept: true, interrupted: false,
        ended: { how: 'finished', handover: true }, turnLog: { complete: true },
      },
    });

    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining([
      'the model is sent "pears"', 'the model is no longer sent "plums"', 'summarises the conversation', 'the conversation keeps a summary',
      'saves the turn as finished', 'the run ends finished', 'it leaves a handover note', 'the turn log holds the whole turn',
    ]));
    expect(api.ports.scripted.requests).toHaveBeenCalledWith('space-1');
  });

  it('observes a step\'s exit and outputs and the tool a single model turn chose from the traces the run left', async () => {
    api.ports.workflows.onStart = async (started) => {
      await standardRun(started);
      await api.db.engine.saveRunTraces([
        { runId: started.runId, ownerId: started.owner, agentSlug: 'koala', procedureId: 'p', procedureVersion: '1', sequence: 2, node: 'step', kind: 'step', exit: 'done', outputs: { text: 'ok then' } },
        { runId: started.runId, ownerId: started.owner, agentSlug: 'koala', procedureId: 'p', procedureVersion: '1', sequence: 3, kind: 'call-model', outputs: { reply: { content: '', toolCalls: [{ name: 'list_files', arguments: '{}' }] } } },
      ] as never);
    };
    const { result } = await perform({ ...CHAT, expect: { exit: 'done', outputs: { text: { contains: 'ok' } }, chooses: { tool: 'list_files' } } });
    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining(['the step leaves by done', 'chooses list_files']));
  });

  it('judges what the run said and the failure it provoked through the checker\'s own judgement', async () => {
    api.ports.workflows.onStart = async ({ runId, conversationId, owner }) => {
      await log(owner, runId, 1, [
        { type: 'run.started', runId, at, agentId: 'koala' },
        { type: 'tool.called', runId, callId: 'c1', name: 'run_command', args: '{}', at },
        { type: 'tool.result', runId, callId: 'c1', ok: false, digest: 'boom', at },
        finishing(runId),
      ]);
      await answerChat(owner, conversationId, runId, 'Hi.');
      await traced(owner, runId, 'qwen/q');
    };
    const { result } = await perform({ ...CHAT, expect: { said: { means: ['says hi'] }, provokes: { tool: 'run_command', when: 'it fails', then: 'reported' } } }, { reported: true, says: true });
    expect(result.checks.find((check) => check.what === 'its answer says hi')?.passed).toBe(true);
    expect(result.checks.find((check) => check.what === 'it tells the person what went wrong')?.passed).toBe(true);
    expect(result.calls).toEqual([{ name: 'run_command', ok: false, digest: 'boom' }]);
  });

  it('saves the procedures the first run changed, as the space\'s own', async () => {
    await api.db.engine.saveProcedure({ id: 'tidy', ownerId: 'space-1', version: '1', source: '{}', updatedAt: 'then' });
    api.ports.workflows.onStart = async (started) => {
      await standardRun(started);
      await api.db.engine.saveProcedure({ id: 'tidy', ownerId: 'space-1', version: '2', source: '{}', updatedAt: 'now' });
    };
    const { result } = await perform({ ...CHAT, expect: { saved: { procedure: 'tidy', stored: false } } });
    expect(result.checks.find((check) => check.what === 'saves no procedure called tidy')).toMatchObject({ passed: false, detail: 'it saved tidy' });
  });

  it('fails the stage with the reason an observation could not be made', async () => {
    api.ports.monitoring.alerts.mockRejectedValue(new Error('down'));
    const { result } = await perform({ ...CHAT, expect: { alertRules: [{ app: 'shop', kind: 'down' }] } });
    expect(result.checks).toEqual([{ what: 'runs to the end', passed: false, detail: 'Request failed with status code 500' }]);
    expect(result.passed).toBe(false);
  });

  it('reads the stories, the repository, the pull requests, the workspace, the plan and the channel\'s notices of the tree it made', async () => {
    const leaf = { id: 'l1', ownerId: 'space-1', branchId: 'b1', title: 'Ship it', status: 'succeeded', verified: true, landed: { at, outcome: 'merged' }, findings: 'See [shot](/api/artifacts/00ab-1) for it', attempts: [{}], drops: [{ state: 'merged' }] };
    await api.db.projects.saveProject({ id: 'p1', name: 'shop-space-1', ownerId: 'space-1', giteaOwner: 'space', giteaRepo: 'r', appType: 'gitapp', createdAt: at } as never);
    await api.db.projects.saveTree({ id: 't1', ownerId: 'space-1', name: 'Shop', type: 'odoo', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
    await api.db.projects.saveBranch({ id: 'b1', ownerId: 'space-1', treeId: 't1', title: 'Billing', createdAt: at, updatedAt: at });
    await api.db.projects.saveLeaf(leaf as never);
    await api.db.projects.saveTask({ id: 'merge-1', ownerId: 'space-1', title: CONFLICT_TASK_TITLE, doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at } as never);
    await api.db.engine.saveConversation({ id: channelIdFor('p1'), ownerId: 'space-1', title: 'shop', kind: 'channel', projectId: 'p1', messages: [{ role: 'notice', content: 'The build is released', at }], createdAt: at, updatedAt: at } as never);
    api.ports.repos.createProject.mockResolvedValue({ id: 'p1', name: 'shop-space-1', ownerId: 'space-1', giteaOwner: 'space', giteaRepo: 'r', appType: 'gitapp', createdAt: at } as never);
    api.ports.artifacts.get.mockImplementation(async () => ({ artifact: { id: '00ab-1', ownerId: 'space-1', runId: 'r1', name: 'shot.png', contentType: 'image/png', size: 12, createdAt: 'now' }, body: Readable.from([Buffer.alloc(12, 1)]) }));
    api.ports.documents.read.mockImplementation(async (_owner, workspace, path) => (workspace === 'tree-t1' && path === 'src/t1.txt' ? { ok: true, document: { content: 'oh hi' } } : { ok: false, status: 404, error: 'none' }) as never);
    api.ports.pullRequests.push({ number: 1, title: 'a', head: 'h', base: 'main', state: 'closed', merged: true }, { number: 2, title: 'b', head: 'h', base: 'main', state: 'open', merged: false }, { number: 3, title: 'c', head: 'h', base: 'main', state: 'closed', merged: false });
    api.ports.workspaceState.conversation = 'running';
    api.ports.removal.preview.mockResolvedValue({ projectName: 'shop' } as never);
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
    api.ports.workflows.onStart = async (started) => {
      await standardRun(started);
      await api.db.projects.savePlanProposal({ id: 'plan-1', ownerId: 'space-1', conversationId: started.conversationId, status: 'proposed', plan: { tree: { name: 'Shop', type: 'odoo', version: '20', release: { agent: 'slots' }, startsFrom: 'client-database' }, planDoc: '#', branches: [] }, createdAt: at, updatedAt: at } as never);
    };
    api.ports.adopter.adoptPlan.mockImplementation(async () => {
      setTimeout(() => {
        void api.db.projects.getPlanProposal('space-1', 'plan-1').then((found) => api.db.projects.savePlanProposal({ ...found!, status: 'adopted', adopted: { treeId: 't1', leafIds: {} } } as never));
      }, 40);
      return 'adopt-1';
    });
    const { result } = await perform({
      ...CHAT,
      world: { project: { name: 'shop' } },
      then: [
        { name: 'approve', do: { approvePlan: true }, expect: { outcome: 'ok' } },
        { name: 'observe', do: { post: { message: 'hi', in: 'channel' } }, expect: expectations },
      ],
    });

    expect(failures(result.checks)).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(15);
    expect(api.ports.documents.read).toHaveBeenCalledWith('space-1', 'tree-t1', 'src/t1.txt', undefined);
  });

  it('reads the alerts set on its apps, the MCP server and who holds it, how builds are released and the models a tree chose', async () => {
    await api.db.projects.saveTree({ id: 't1', ownerId: 'space-1', name: 'Shop', type: 'odoo', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
    await api.db.projects.saveTreeType({ id: 'odoo', ownerId: 'space-1', name: 'Odoo', release: { agent: 'slots' } } as never);
    await api.db.projects.saveProject({ id: 'p1', name: 'shop-space-1', ownerId: 'space-1', giteaOwner: 'space', giteaRepo: 'r', appType: 'gitapp', createdAt: at } as never);
    api.ports.repos.createProject.mockResolvedValue({ id: 'p1', name: 'shop-space-1', ownerId: 'space-1', giteaOwner: 'space', giteaRepo: 'r', appType: 'gitapp', createdAt: at } as never);
    api.ports.clusters.getById.mockResolvedValue({ id: 'machine-koala' } as never);
    api.ports.bridge.deployApp.mockResolvedValue({ resourceId: 'd1', id: 'wf-1' } as never);
    api.ports.appService.getAll.mockResolvedValue([{ id: 'd1', status: 'running' }] as never);
    api.ports.monitoring.alerts.mockResolvedValue({ rules: [{ deploymentId: 'd1', spec: { kind: 'down' } }] } as never);
    api.ports.catalogue.catalogue.mockResolvedValue({ servers: [{ name: 'files', status: { state: 'captured' } }] } as never);
    api.ports.agents.list.mockResolvedValue([{ slug: 'executor', servers: ['files'] }, { slug: 'judge' }] as never);
    api.ports.releaseSettings.ofProject.mockResolvedValue({ ok: true, value: { how: { agent: 'slots', app: 'odoo' }, from: 'type' } } as never);
    api.ports.treeModels.view.mockResolvedValue({ ok: true, value: { rows: [{ agent: 'judge', chosen: { modelId: 'qwen/q' } }, { agent: 'executor' }] } } as never);
    api.ports.workflows.onStart = async (started) => {
      await standardRun(started);
      await api.db.projects.savePlanProposal({ id: 'plan-1', ownerId: 'space-1', conversationId: started.conversationId, status: 'proposed', plan: { tree: { name: 'Shop', type: 'odoo' }, planDoc: '#', branches: [] }, createdAt: at, updatedAt: at } as never);
    };
    api.ports.adopter.adoptPlan.mockImplementation(async () => {
      setTimeout(() => {
        void api.db.projects.getPlanProposal('space-1', 'plan-1').then((found) => api.db.projects.savePlanProposal({ ...found!, status: 'adopted', adopted: { treeId: 't1', leafIds: {} } } as never));
      }, 40);
      return 'adopt-1';
    });
    const { result } = await perform({
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
    });

    expect(failures(result.checks)).toEqual([]);
    expect(api.ports.releaseSettings.ofProject).toHaveBeenCalled();
  });

  it('waits for an MCP server being captured to settle before reading it', async () => {
    api.ports.catalogue.catalogue
      .mockResolvedValueOnce({ servers: [{ name: 'files', status: { state: 'capturing' } }] } as never)
      .mockResolvedValueOnce({ servers: [{ name: 'files', status: { state: 'capturing' } }] } as never)
      .mockResolvedValue({ servers: [{ name: 'files', status: { state: 'failed', why: 'no tools' } }] } as never);
    api.ports.agents.list.mockResolvedValue([] as never);
    const { result } = await perform({ ...CHAT, expect: { mcpServer: { name: 'files', state: 'captured' } } });
    expect(api.ports.catalogue.catalogue).toHaveBeenCalledTimes(3);
    expect(result.checks.find((check) => check.what === 'files is captured')?.detail).toBe('it is failed: no tools');
  });

  it('finds out whether the project is gone', async () => {
    api.ports.repos.createProject.mockImplementation(async (ownerId, input) => {
      const project = { id: 'p1', name: input.name, ownerId, giteaOwner: 'space', giteaRepo: input.repo, appType: 'gitapp' as const, createdAt: at };
      await api.db.projects.saveProject(project as never);
      return project as never;
    });
    api.ports.removal.preview.mockResolvedValue(undefined as never);
    const { result } = await perform({ ...CHAT, world: { project: { name: 'shop' } }, expect: { project: { exists: false } } });
    expect(failures(result.checks)).toEqual([]);
  });

  it('reads the build of a client project and the client database it awaits', async () => {
    await releasing({ builds: [build({ releaseHeld: 'waiting for the client' })] });
    api.ports.imports.view.mockResolvedValue({ ok: true, value: { import: { state: 'awaited' } } } as never);
    const { result } = await perform({ ...STORY, then: [{ name: 'built', do: { waitBuild: true }, expect: { build: { held: true }, clientImport: { state: 'awaited' } } }] });
    expect(result.checks.map((check) => check.what)).toEqual(expect.arrayContaining(['built: its build is held', 'built: the client\'s database is awaited']));
    expect(failures(result.checks)).toEqual([]);
  });
});

describe('what a check noticed and what its space left behind', () => {
  it('collects the poisoning signals of every space it was handed from the real store', async () => {
    await api.db.engine.savePoisoningSignal({ id: 's1', ownerId: 'space-1', kind: 'canary', severity: 'high', state: 'open', at: 't', readsKey: 'k', runId: 'r', tool: 'fetch', said: 'a canary left' } as never);
    expect(await activities().CheckNoticedActivity({ spaceIds: ['space-1', 'space-2'] })).toEqual([{ kind: 'canary', said: 'a canary left' }]);
  });

  it('lists what the space left: records, workspaces and its Gitea user', async () => {
    expect(await activities().CheckSpaceGoneActivity({ spaceId: 'space-1' })).toEqual(['1 in users', 'the workspace ws-1', 'its Gitea user']);
  });
});

describe('recording a check run\'s progress in the real store', () => {
  it('adds a result once, clears the scenario that was running, and ignores a run that is gone', async () => {
    const progress = createCheckProgressActivity(api.db.checks as never);
    await api.db.checks.saveEvalRecord('evalScenarioRuns', { id: 'c1', ownerId: 'bo', results: [], finished: 0, running: 'a' } as never);

    await progress.CheckProgressActivity({ ownerId: 'bo', checkRunId: 'c1', result: { scenarioId: 's1' } as never, running: 'b' });
    expect(await api.db.checks.getEvalRecord('evalScenarioRuns', 'bo', 'c1')).toMatchObject({ results: [{ scenarioId: 's1' }], finished: 1, running: 'b' });

    await progress.CheckProgressActivity({ ownerId: 'bo', checkRunId: 'c1', result: { scenarioId: 's1' } as never });
    const again = await api.db.checks.getEvalRecord<{ id: string; ownerId: string; results: unknown[]; running?: string }>('evalScenarioRuns', 'bo', 'c1');
    expect(again?.results).toHaveLength(1);
    expect(again?.running).toBeUndefined();

    await progress.CheckProgressActivity({ ownerId: 'bo', checkRunId: 'gone' });
    expect(await api.db.checks.getEvalRecord('evalScenarioRuns', 'bo', 'gone')).toBeNull();
  });
});

describe('a check run that is cancelled', () => {
  it('stops following the run, cancels it through the real run route and ends with the cancellation\'s reason', async () => {
    api.ports.workflows.onStart = async ({ runId, conversationId, owner }) => {
      await log(owner, runId, 1, [{ type: 'run.started', runId, at, agentId: 'koala' }]);
      await answerChat(owner, conversationId, runId, 'x');
    };
    await makeSpace();
    const env = new MockActivityEnvironment();
    const watching = env.run(() => activities().CheckRunScenarioActivity({ spaceId: 'space-1', checkRunId: 'c1', person: 'bo', scenario: CHAT, tools: [] })).catch((error: Error) => error);
    await vi.waitFor(() => expect(api.ports.workflows.started.length).toBe(1));
    env.cancel('CANCELLED');
    expect(await watching).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(api.ports.workflows.signals.map((signal) => signal.name)).toEqual(['cancelRun']));
  });

  it('stops waiting for an MCP server to be captured', async () => {
    api.ports.catalogue.recapture.mockResolvedValue({ ok: true, server: {} } as never);
    api.ports.catalogue.get.mockResolvedValue({ status: { state: 'capturing' } } as never);
    await makeSpace();
    const env = new MockActivityEnvironment();
    const watching = env.run(() => activities().CheckRunScenarioActivity({
      spaceId: 'space-1', checkRunId: 'c1', person: 'bo', tools: [], scenario: { ...CHAT, world: { mcpServers: [{ name: 'files', runs: { hosted: true } } as never] } },
    })).catch((error: Error) => error);
    await vi.waitFor(() => expect(api.ports.catalogue.get.mock.calls.length).toBeGreaterThan(1));
    env.cancel('CANCELLED');
    expect(await watching).toBeInstanceOf(Error);
  });

  it('fails at once, saying so, when the space is gone', async () => {
    const { result, runIds } = await activities().CheckRunScenarioActivity({ spaceId: 'space-9', checkRunId: 'c1', person: 'bo', scenario: CHAT, tools: [] });
    expect(result).toMatchObject({ passed: false, outcome: 'failed', error: 'the check\'s space is gone' });
    expect(runIds).toEqual([]);
  });
});
