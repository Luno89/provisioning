import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { evalsLevel2Router } from './evals-level2.js';
import { Level2Service } from '../services/Level2Service.js';
import { BenchService } from '../services/BenchService.js';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';
import type { Scenario } from '../eval/level2/scenario.js';
import { seededPersonas } from '../extensions/seeds.js';

const quiet = { validateStatus: () => true };

const SCENARIO: Scenario = {
  id: 'builder-saves', name: 'The builder saves', describe: 'It writes what it was given.', agent: 'agent-builder',
  procedure: { id: 'tool-rounds' }, input: { message: 'save it' }, expect: { outcome: 'ok' },
};

const level2Harness = (): Promise<Harness> => mountRouter({
  prefix: '/api/evals/level2',
  router: (db) => evalsLevel2Router({
    level2: new Level2Service({
      checks: {
        start: async () => undefined,
        cancel: async () => false,
        outcome: async () => ({
          cancelled: false,
          results: [{ scenarioId: 'builder-saves', name: 'The builder saves', runId: 'run-x', procedure: { id: 'tool-rounds', version: '3' }, passed: true, outcome: 'ok', answer: 'Saved.', checks: [{ what: 'finishes ok', passed: true, detail: 'it finished ok' }], calls: [], counters: { rounds: 1, toolCalls: 1, totalTokens: 1 }, tasks: [], durationMs: 1 }],
        }),
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

  it('serves the procedure made for a turn or step check, so its run can be drawn after its space is gone', async () => {
    const h = await level2Harness();
    const turn = { ...SCENARIO, id: 'turn-reads', procedure: { id: 'turn-check' }, turn: true, expect: { chooses: { tool: 'read_procedure' } } };
    const step = { ...SCENARIO, id: 'step-decides', procedure: { id: 'step-check-step-decides' }, step: { node: 'decide', settings: { question: 'Done?' } }, expect: { exit: 'yes' } };
    expect((await axios.put(h.url('/api/evals/level2/scenarios/turn-reads'), turn, quiet)).status).toBe(200);
    expect((await axios.put(h.url('/api/evals/level2/scenarios/step-decides'), step, quiet)).status).toBe(200);

    expect((await axios.get(h.url('/api/evals/level2/scenarios/turn-reads/procedure'))).data.procedure.id).toBe('turn-check');
    expect((await axios.get(h.url('/api/evals/level2/scenarios/step-decides/procedure'))).data.procedure.id).toBe('step-check-step-decides');
    expect((await axios.get(h.url('/api/evals/level2/scenarios/builder-saves/procedure'), quiet)).status).toBe(404);
    await h.close();
  });

  it('says what the checks leave uncovered', async () => {
    const h = await level2Harness();

    const uncovered = async () => ((await axios.get(h.url('/api/evals/level2/coverage'))).data.gaps as { kind: string; tool?: string }[])
      .filter((gap) => gap.kind === 'uncovered').map((gap) => gap.tool);
    expect(await uncovered()).toContain('check_procedure');
    expect((await axios.put(h.url('/api/evals/level2/scenarios/mine'), { ...SCENARIO, id: 'mine', expect: { toolsCalled: ['check_procedure'] } }, quiet)).status).toBe(200);
    expect(await uncovered()).not.toContain('check_procedure');
    await h.close();
  });

  it('compares two check runs of yours, and refuses one that is not', async () => {
    const h = await level2Harness();
    const started = await axios.post(h.url('/api/evals/level2/runs'), {}, quiet);
    for (let tries = 0; tries < 400 && (await axios.get(h.url(`/api/evals/level2/runs/${started.data.id}`))).data.state === 'running'; tries += 1) await new Promise((done) => setTimeout(done, 10));

    const same = await axios.get(h.url('/api/evals/level2/compare'), { params: { before: started.data.id, after: started.data.id } });
    expect(same.data).toMatchObject({ differences: [], checks: [{ id: 'builder-saves', change: 0 }] });
    expect((await axios.get(h.url('/api/evals/level2/compare'), { params: { before: started.data.id, after: 'ghost' }, ...quiet })).status).toBe(404);
    expect((await axios.get(h.url('/api/evals/level2/compare'), quiet)).status).toBe(400);
    await h.close();
  });

  it('starts a scenario run on the check runner and reports how it went', async () => {
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
