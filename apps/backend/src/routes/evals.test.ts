import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { BUILDER_TOOLS, type ModelProvider } from '@koala/agent-engine';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { evalsLevel1Router } from './evals-level1.js';
import { evalsLevel2Router } from './evals-level2.js';
import { Level1Service } from '../services/Level1Service.js';
import { Level2Service } from '../services/Level2Service.js';
import { BenchService } from '../services/BenchService.js';
import { createAgentRegistry } from '../engine-host/registries/registry.js';
import { createProcedureExecutor, type HostNodeServices } from '../engine-host/nodes/index.js';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';
import type { EvalCase } from '../eval/cases.js';
import type { Scenario } from '../eval/level2/scenario.js';
import { inMemoryConversations } from '../engine-host/nodes/conversation-nodes.js';
import { seededPersonas } from '../extensions/seeds.js';

const PROVIDER = { id: 'tabby', name: 'Tabby', source: 'deployment', model: 'test-model', contextTokens: 32_000 } as ModelProvider;
const quiet = { validateStatus: () => true };

const CASE: EvalCase = { name: 'builder/reads', category: 'simple', agent: 'agent-builder', say: 'show me research', expect: { tool: 'read_procedure' } };
const SCENARIO: Scenario = {
  id: 'builder-saves', name: 'The builder saves', describe: 'It writes what it was given.', agent: 'agent-builder',
  procedure: { id: 'tool-rounds' }, input: { message: 'save it' }, expect: { outcome: 'ok' },
};

function stubModel(content: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers(), text: async () => '',
    body: (async function* () {
      yield `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n`;
      yield 'data: [DONE]\n';
    })(),
  } as unknown as Response)));
}

const level1Harness = (): Promise<Harness> => mountRouter({
  prefix: '/api/evals/level1',
  router: (db) => {
    const registry = createAgentRegistry();
    const services: HostNodeServices = {
      conversations: inMemoryConversations(),
      registry,
      models: { resolveBaseUrl: async () => ({ provider: PROVIDER, baseUrl: 'https://models.test/v1', apiKey: 'k' }) },
      tools: { run: async () => ({ ok: true, digest: '', content: '' }) },
      environments: { describe: async () => ({ kind: 'none', egress: false }), release: async () => undefined },
      memories: { list: async () => [], save: async () => undefined },
    };
    return evalsLevel1Router({
      level1: new Level1Service({
        executor: createProcedureExecutor(services, { registry }),
        tools: async () => [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS],
        agents: async () => seededPersonas().map((agent) => agent.slug),
        store: db,
        builtIn: [CASE],
        newId: () => 'run-1',
      }),
    });
  },
});

const level2Harness = (): Promise<Harness> => mountRouter({
  prefix: '/api/evals/level2',
  router: (db) => evalsLevel2Router({
    level2: new Level2Service({
      world: {
        models: { resolveBaseUrl: async () => ({ provider: PROVIDER, baseUrl: 'https://models.test/v1', apiKey: 'k' }) },
        personas: async () => [...seededPersonas()],
        tools: async () => [],
        procedures: async () => [],
      },
      tools: async () => [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS],
      agents: async () => seededPersonas().map((agent) => agent.slug),
      procedures: async () => ['tool-rounds'],
      store: db,
      builtIn: [SCENARIO],
      newId: () => 'run-2',
    }),
    bench: new BenchService({
      store: db,
      scenarios: async () => [],
      fingerprints: async () => ({}),
      practices: { trials: async () => [], settle: async () => undefined },
      changes: { pending: async () => [], comparing: async () => undefined, settle: async () => undefined },
      earlier: async () => [],
      notifyChange: () => undefined,
      start: async () => undefined,
      benchRunning: async () => false,
      agentsRunning: async () => false,
      idleTimer: async () => undefined,
      notify: () => undefined,
    }),
  }),
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('level 1 eval routes', () => {
  it('lists the cases with what the suite does not cover yet', async () => {
    const h = await level1Harness();
    const res = await axios.get(h.url('/api/evals/level1/cases'));

    expect(res.status).toBe(200);
    expect(res.data.cases).toEqual([{ ...CASE, mine: false }]);
    expect(res.data.coverage.some((problem: { kind: string }) => problem.kind === 'uncovered')).toBe(true);
    await h.close();
  });

  it('saves, lists and deletes a case of your own, and refuses a broken one', async () => {
    const h = await level1Harness();
    const mine = { ...CASE, name: 'builder/mine', say: 'read the planner' };

    const saved = await axios.put(h.url('/api/evals/level1/cases/builder/mine'), mine, quiet);
    const wrongPath = await axios.put(h.url('/api/evals/level1/cases/builder/elsewhere'), mine, quiet);
    const broken = await axios.put(h.url('/api/evals/level1/cases/builder/mine'), { ...mine, agent: 'ghost' }, quiet);

    expect(saved.status).toBe(200);
    expect((await axios.get(h.url('/api/evals/level1/cases'))).data.cases.map((entry: { name: string }) => entry.name)).toEqual(['builder/mine', 'builder/reads']);
    expect(wrongPath.status).toBe(400);
    expect(broken.data.problems).toEqual(['there is no agent called "ghost"']);
    expect((await axios.delete(h.url('/api/evals/level1/cases/builder/mine'))).status).toBe(200);
    expect((await axios.delete(h.url('/api/evals/level1/cases/builder/mine'), quiet)).status).toBe(404);
    await h.close();
  });

  it('runs a case, keeps the prompt behind its hash, and refuses knobs out of range', async () => {
    stubModel('I will not call anything');
    const h = await level1Harness();

    const started = await axios.post(h.url('/api/evals/level1/runs'), { repeats: 1 }, quiet);
    expect(started.status).toBe(202);

    let run = started.data;
    for (let tries = 0; tries < 200 && run.state === 'running'; tries += 1) {
      await new Promise((done) => setTimeout(done, 10));
      run = (await axios.get(h.url(`/api/evals/level1/runs/${started.data.id}`))).data;
    }

    expect(run).toMatchObject({ state: 'done', summary: { reliability: { cases: 1, never: 1 } } });
    const hash = run.results[0].attempts[0].systemHash;
    expect((await axios.get(h.url(`/api/evals/level1/prompts/${hash}`))).data.text).toContain('You build procedures');
    expect((await axios.get(h.url('/api/evals/level1/prompts/nope'), quiet)).status).toBe(404);
    expect((await axios.post(h.url('/api/evals/level1/runs'), { repeats: 99 }, quiet)).data.error).toContain('between 1 and 25');
    expect((await axios.post(h.url('/api/evals/level1/runs'), { only: ['ghost/case'] }, quiet)).data.error).toContain('there is no case called "ghost/case"');
    expect((await axios.post(h.url('/api/evals/level1/runs/run-1/cancel'), {}, quiet)).status).toBe(409);
    await h.close();
  }, 30_000);

  it('only shows a run to the person who started it', async () => {
    stubModel('nothing');
    const h = await level1Harness();
    await axios.post(h.url('/api/evals/level1/runs'), { repeats: 1 }, quiet);

    h.setUser({ ...TEST_USER, id: 'someone-else' });
    expect((await axios.get(h.url('/api/evals/level1/runs/run-1'), quiet)).status).toBe(404);
    expect((await axios.get(h.url('/api/evals/level1/compare?before=run-1&after=run-1'), quiet)).status).toBe(404);
    await h.close();
  }, 30_000);
});

describe('level 2 eval routes', () => {
  it('lists proposed tests, accepts one into the person\'s scenarios — edited or as proposed — and dismisses another', async () => {
    const harness = await level2Harness();
    try {
      const proposal = (id: string) => ({
        id, ownerId: TEST_USER.id, status: 'proposed', why: 'it guessed', createdAt: `2026-10-03T12:00:0${id.length % 10}Z`,
        scenario: { id, name: 'Saves when asked', describe: 'It saves.', agent: 'agent-builder', procedure: { id: 'tool-rounds' }, input: { message: 'save it' }, expect: { outcome: 'ok' } },
      });
      await harness.db.saveEvalRecord('evalScenarioProposals', proposal('agent-builder-saves') as never);
      await harness.db.saveEvalRecord('evalScenarioProposals', proposal('agent-builder-other') as never);

      expect((await axios.get(harness.url('/api/evals/level2/proposals'))).data.proposals.map((entry: { id: string }) => entry.id).sort()).toEqual(['agent-builder-other', 'agent-builder-saves']);

      const edited = { ...proposal('agent-builder-saves').scenario, name: 'Saves when asked, edited' };
      const accepted = await axios.post(harness.url('/api/evals/level2/proposals/agent-builder-saves/accept'), { scenario: edited }, quiet);
      expect(accepted.data.scenario).toMatchObject({ id: 'agent-builder-saves', name: 'Saves when asked, edited' });
      expect((await axios.get(harness.url('/api/evals/level2/scenarios'))).data.scenarios.some((scenario: { id: string }) => scenario.id === 'agent-builder-saves')).toBe(true);
      expect((await axios.post(harness.url('/api/evals/level2/proposals/agent-builder-saves/accept'), {}, quiet)).status).toBe(404);

      expect((await axios.post(harness.url('/api/evals/level2/proposals/agent-builder-other/dismiss'), {}, quiet)).data).toEqual({ dismissed: true });
      const statuses = (await axios.get(harness.url('/api/evals/level2/proposals'))).data.proposals.map((entry: { id: string; status: string }) => `${entry.id}:${entry.status}`).sort();
      expect(statuses).toEqual(['agent-builder-other:dismissed', 'agent-builder-saves:accepted']);
    } finally {
      await harness.close();
    }
  });

  it('refuses to accept a proposed test that does not check out, and keeps it waiting', async () => {
    const harness = await level2Harness();
    try {
      await harness.db.saveEvalRecord('evalScenarioProposals', {
        id: 'broken', ownerId: TEST_USER.id, status: 'proposed', why: 'x', createdAt: 'now',
        scenario: { id: 'broken', name: 'Broken', describe: 'x', agent: 'nobody', procedure: { id: 'tool-rounds' }, input: { message: 'x' }, expect: { outcome: 'ok' } },
      } as never);
      const refused = await axios.post(harness.url('/api/evals/level2/proposals/broken/accept'), {}, quiet);
      expect(refused.status).toBe(400);
      expect(refused.data.problems).toContain('there is no agent called "nobody"');
      expect((await axios.get(harness.url('/api/evals/level2/proposals'))).data.proposals[0].status).toBe('proposed');
    } finally {
      await harness.close();
    }
  });

  it('reads the bench settings, defaults first, and saves good ones while refusing bad ones', async () => {
    const harness = await level2Harness();
    try {
      expect((await axios.get(harness.url('/api/evals/level2/bench'))).data).toEqual({
        settings: { enabled: true, idleMinutes: 15, fullEveryHours: 24 },
        state: { ownerId: TEST_USER.id, benched: {} },
      });
      const saved = await axios.put(harness.url('/api/evals/level2/bench'), { enabled: false, idleMinutes: 30, fullEveryHours: 48 }, quiet);
      expect(saved.data).toEqual({ settings: { enabled: false, idleMinutes: 30, fullEveryHours: 48 } });
      const refused = await axios.put(harness.url('/api/evals/level2/bench'), { enabled: true, idleMinutes: -1, fullEveryHours: 48 }, quiet);
      expect(refused.status).toBe(400);
      expect((await axios.get(harness.url('/api/evals/level2/bench'))).data.settings).toEqual({ enabled: false, idleMinutes: 30, fullEveryHours: 48 });
    } finally {
      await harness.close();
    }
  });

  it('lists scenarios, saves one of your own, and refuses a broken one', async () => {
    const h = await level2Harness();

    expect((await axios.get(h.url('/api/evals/level2/scenarios'))).data.scenarios).toEqual([{ ...SCENARIO, mine: false }]);
    const saved = await axios.put(h.url('/api/evals/level2/scenarios/mine'), { ...SCENARIO, id: 'mine' }, quiet);
    const broken = await axios.put(h.url('/api/evals/level2/scenarios/mine'), { ...SCENARIO, id: 'mine', procedure: { id: 'ghost' } }, quiet);

    expect(saved.status).toBe(200);
    expect(broken.data.problems).toEqual(['there is no procedure called "ghost"']);
    expect((await axios.delete(h.url('/api/evals/level2/scenarios/mine'))).status).toBe(200);
    expect((await axios.delete(h.url('/api/evals/level2/scenarios/builder-saves'), quiet)).status).toBe(404);
    await h.close();
  });

  it('starts a scenario run and reports how it went', async () => {
    stubModel('Saved.');
    const h = await level2Harness();

    const started = await axios.post(h.url('/api/evals/level2/runs'), {}, quiet);
    expect(started.status).toBe(202);

    let run = started.data;
    for (let tries = 0; tries < 400 && run.state === 'running'; tries += 1) {
      await new Promise((done) => setTimeout(done, 10));
      run = (await axios.get(h.url(`/api/evals/level2/runs/${started.data.id}`))).data;
    }

    expect(run.state).toBe('done');
    expect(run.results[0]).toMatchObject({ scenarioId: 'builder-saves', passed: true, outcome: 'ok' });
    expect((await axios.post(h.url('/api/evals/level2/runs'), { only: ['ghost'] }, quiet)).data.error).toContain('there is no scenario called "ghost"');
    expect((await axios.post(h.url('/api/evals/level2/runs'), { temperature: 9 }, quiet)).status).toBe(400);
    await h.close();
  }, 30_000);
});
