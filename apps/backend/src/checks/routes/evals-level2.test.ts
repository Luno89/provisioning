import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { AgentChange, AgentChangeService } from '../../engine/index.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import type { MemoryItem, PracticeService } from '../../memory/index.js';
import type { BenchService } from '../services/BenchService.js';
import type { Level2Run, Level2Service } from '../services/Level2Service.js';
import { evalsLevel2Router, type Level2RouterDeps } from './evals-level2.js';

const SCENARIO: Scenario = {
  id: 'builder-saves', name: 'The builder saves', describe: 'It writes what it was given.', agent: 'agent-builder',
  procedure: { id: 'tool-rounds' }, input: { message: 'save it' }, expect: { outcome: 'ok' },
};

const PREFIX = '/api/evals/level2';

let level2: ReturnType<typeof mock<Level2Service>>;
let bench: ReturnType<typeof mock<BenchService>>;
let practices: ReturnType<typeof mock<PracticeService>>;
let notes: ReturnType<typeof mock<PracticeService>>;
let changes: ReturnType<typeof mock<AgentChangeService>>;

const mounted = (over: Partial<Level2RouterDeps> = {}): Promise<InProcessRoutes> =>
  routesInProcess({ prefix: PREFIX, router: () => evalsLevel2Router({ level2, bench, practices, notes, changes, ...over }) });

beforeEach(() => {
  level2 = mock<Level2Service>();
  bench = mock<BenchService>();
  practices = mock<PracticeService>();
  notes = mock<PracticeService>();
  changes = mock<AgentChangeService>();
});

const item = (id: string): MemoryItem => ({ id, ownerId: TEST_USER.id, title: id, text: id, createdAt: 'a', updatedAt: 'a' } as MemoryItem);

describe('the bench routes', () => {
  it('reads the bench\'s settings and state for the signed-in person', async () => {
    bench.settings.mockResolvedValue({ enabled: true, idleMinutes: 15, fullEveryHours: 24 });
    bench.state.mockResolvedValue({ ownerId: TEST_USER.id, benched: {} });
    expect(await (await mounted()).get(`${PREFIX}/bench`)).toMatchObject({ status: 200, data: { settings: { idleMinutes: 15 }, state: { benched: {} } } });
    expect(bench.settings).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('saves good settings and answers the problems of bad ones with a 400', async () => {
    const app = await mounted();
    bench.saveSettings.mockResolvedValueOnce({ saved: true, settings: { enabled: false, idleMinutes: 30, fullEveryHours: 48 } });
    expect(await app.put(`${PREFIX}/bench`, { enabled: false, idleMinutes: 30, fullEveryHours: 48 })).toMatchObject({ status: 200, data: { settings: { idleMinutes: 30 } } });
    expect(bench.saveSettings).toHaveBeenCalledWith(TEST_USER.id, { enabled: false, idleMinutes: 30, fullEveryHours: 48 });
    bench.saveSettings.mockResolvedValueOnce({ saved: false, problems: ['idleMinutes has to be positive'] });
    expect(await app.put(`${PREFIX}/bench`, {})).toMatchObject({ status: 400, data: { problems: ['idleMinutes has to be positive'] } });
  });

  it('says there is no bench where none is mounted', async () => {
    const app = await mounted({ bench: undefined });
    expect(await app.get(`${PREFIX}/bench`)).toMatchObject({ status: 404, data: { error: 'there is no bench here' } });
    expect(await app.put(`${PREFIX}/bench`, {})).toMatchObject({ status: 404 });
  });
});

describe('the prompt change routes', () => {
  it('lists the changes, or none where there is no service', async () => {
    changes.list.mockResolvedValue([{ id: 'c1' } as AgentChange]);
    expect(await (await mounted()).get(`${PREFIX}/changes`)).toMatchObject({ data: { changes: [{ id: 'c1' }] } });
    expect(await (await mounted({ changes: undefined })).get(`${PREFIX}/changes`)).toMatchObject({ data: { changes: [] } });
  });

  it('accepts a change with the prompt as edited, and answers a refusal with its status and problems', async () => {
    const app = await mounted();
    changes.accept.mockResolvedValueOnce({ accepted: true, change: { id: 'c1', status: 'accepted' } as AgentChange });
    expect(await app.post(`${PREFIX}/changes/c1/accept`, { prompt: 'edited' })).toMatchObject({ status: 200, data: { change: { id: 'c1' } } });
    expect(changes.accept).toHaveBeenCalledWith(TEST_USER.id, 'c1', 'edited');
    changes.accept.mockResolvedValueOnce({ accepted: false, status: 409, problems: ['it is comparing'] });
    expect(await app.post(`${PREFIX}/changes/c1/accept`, {})).toMatchObject({ status: 409, data: { problems: ['it is comparing'] } });
    expect(await (await mounted({ changes: undefined })).post(`${PREFIX}/changes/c1/accept`)).toMatchObject({ status: 404 });
  });

  it('hands a procedure request over to the builder, and answers a refusal with its status', async () => {
    const app = await mounted();
    changes.handOver.mockResolvedValueOnce({ accepted: true, change: { id: 'c2' } as AgentChange });
    expect(await app.post(`${PREFIX}/changes/c2/hand-over`)).toMatchObject({ status: 200, data: { change: { id: 'c2' } } });
    expect(changes.handOver).toHaveBeenCalledWith(TEST_USER.id, 'c2');
    changes.handOver.mockResolvedValueOnce({ accepted: false, status: 404, problems: ['no such request'] });
    expect(await app.post(`${PREFIX}/changes/c2/hand-over`)).toMatchObject({ status: 404, data: { problems: ['no such request'] } });
    expect(await (await mounted({ changes: undefined })).post(`${PREFIX}/changes/c2/hand-over`)).toMatchObject({ status: 404 });
  });

  it('dismisses a change that is waiting, and says when none is', async () => {
    const app = await mounted();
    changes.dismiss.mockResolvedValueOnce(true);
    expect(await app.post(`${PREFIX}/changes/c1/dismiss`)).toMatchObject({ status: 200, data: { dismissed: true } });
    changes.dismiss.mockResolvedValueOnce(false);
    expect(await app.post(`${PREFIX}/changes/c1/dismiss`)).toMatchObject({ status: 404 });
    expect(await (await mounted({ changes: undefined })).post(`${PREFIX}/changes/c1/dismiss`)).toMatchObject({ status: 404 });
  });
});

describe.each([
  ['practices', 'practice', () => practices, 'practices'],
  ['tool-notes', 'note', () => notes, 'notes'],
] as const)('the %s routes', (path, field, service, key) => {
  it('lists them, or none where there is no service', async () => {
    service().list.mockResolvedValue([item('a')]);
    expect(await (await mounted()).get(`${PREFIX}/${path}`)).toMatchObject({ data: { [key]: [{ id: 'a' }] } });
    expect(await (await mounted({ practices: undefined, notes: undefined })).get(`${PREFIX}/${path}`)).toMatchObject({ data: { [key]: [] } });
  });

  it('puts one live, and says when none is waiting', async () => {
    const app = await mounted();
    service().makeLive.mockResolvedValueOnce(item('a'));
    expect(await app.post(`${PREFIX}/${path}/a/live`)).toMatchObject({ status: 200, data: { [field]: { id: 'a' } } });
    expect(service().makeLive).toHaveBeenCalledWith(TEST_USER.id, 'a');
    service().makeLive.mockResolvedValueOnce(undefined);
    expect(await app.post(`${PREFIX}/${path}/a/live`)).toMatchObject({ status: 404 });
    expect(await (await mounted({ practices: undefined, notes: undefined })).post(`${PREFIX}/${path}/a/live`)).toMatchObject({ status: 404 });
  });

  it('retires one, and says when there is none', async () => {
    const app = await mounted();
    service().retire.mockResolvedValueOnce(true);
    expect(await app.post(`${PREFIX}/${path}/a/retire`)).toMatchObject({ status: 200, data: { retired: true } });
    service().retire.mockResolvedValueOnce(false);
    expect(await app.post(`${PREFIX}/${path}/a/retire`)).toMatchObject({ status: 404 });
    expect(await (await mounted({ practices: undefined, notes: undefined })).post(`${PREFIX}/${path}/a/retire`)).toMatchObject({ status: 404 });
  });
});

describe('the proposal routes', () => {
  it('lists proposed tests', async () => {
    level2.proposals.mockResolvedValue([{ id: 'p1' } as never]);
    expect(await (await mounted()).get(`${PREFIX}/proposals`)).toMatchObject({ data: { proposals: [{ id: 'p1' }] } });
  });

  it('accepts one with the scenario as edited, refuses one that does not check out, and says when none is waiting', async () => {
    const app = await mounted();
    level2.acceptProposal.mockResolvedValueOnce({ saved: true, scenario: { ...SCENARIO, ownerId: TEST_USER.id, updatedAt: 't' } });
    expect(await app.post(`${PREFIX}/proposals/p1/accept`, { scenario: SCENARIO })).toMatchObject({ status: 200, data: { scenario: { id: 'builder-saves' } } });
    expect(level2.acceptProposal).toHaveBeenCalledWith(TEST_USER.id, 'p1', SCENARIO);
    level2.acceptProposal.mockResolvedValueOnce({ saved: false, problems: ['there is no agent called "nobody"'] });
    expect(await app.post(`${PREFIX}/proposals/p1/accept`, {})).toMatchObject({ status: 400, data: { problems: ['there is no agent called "nobody"'] } });
    level2.acceptProposal.mockResolvedValueOnce({ missing: true });
    expect(await app.post(`${PREFIX}/proposals/p1/accept`, {})).toMatchObject({ status: 404 });
  });

  it('dismisses one that is waiting, and says when none is', async () => {
    const app = await mounted();
    level2.dismissProposal.mockResolvedValueOnce(true);
    expect(await app.post(`${PREFIX}/proposals/p1/dismiss`)).toMatchObject({ status: 200, data: { dismissed: true } });
    level2.dismissProposal.mockResolvedValueOnce(false);
    expect(await app.post(`${PREFIX}/proposals/p1/dismiss`)).toMatchObject({ status: 404 });
  });
});

describe('the scenario routes', () => {
  it('says what the checks leave uncovered, and lists the scenarios', async () => {
    const app = await mounted();
    level2.coverage.mockResolvedValue([{ kind: 'uncovered', tool: 'check_procedure', message: 'no check touches check_procedure' }]);
    level2.scenarios.mockResolvedValue([{ ...SCENARIO, mine: false }]);
    expect(await app.get(`${PREFIX}/coverage`)).toMatchObject({ data: { gaps: [{ tool: 'check_procedure' }] } });
    expect(await app.get(`${PREFIX}/scenarios`)).toMatchObject({ data: { scenarios: [{ id: 'builder-saves', mine: false }] } });
  });

  it('saves a scenario under the id in the address, refuses a body that names another, and reports what is wrong with a broken one', async () => {
    const app = await mounted();
    level2.saveScenario.mockResolvedValueOnce({ saved: true, scenario: { ...SCENARIO, id: 'mine', ownerId: TEST_USER.id } });
    expect(await app.put(`${PREFIX}/scenarios/mine`, { ...SCENARIO, id: 'mine' })).toMatchObject({ status: 200, data: { scenario: { id: 'mine' } } });
    expect(level2.saveScenario).toHaveBeenCalledWith(TEST_USER.id, { ...SCENARIO, id: 'mine' });
    expect(await app.put(`${PREFIX}/scenarios/mine`, { ...SCENARIO, id: 'other' })).toMatchObject({ status: 400, data: { error: 'the scenario in the body is not called "mine"' } });
    level2.saveScenario.mockResolvedValueOnce({ saved: false, problems: ['there is no procedure called "ghost"'] });
    expect(await app.put(`${PREFIX}/scenarios/mine`, { ...SCENARIO, id: 'mine' })).toMatchObject({ status: 400, data: { error: 'The scenario has problems', problems: ['there is no procedure called "ghost"'] } });
  });

  it('serves the procedure made for a check, and says when it runs a stored one', async () => {
    const app = await mounted();
    level2.checkProcedure.mockResolvedValueOnce({ id: 'turn-check' } as never);
    expect(await app.get(`${PREFIX}/scenarios/turn-reads/procedure`)).toMatchObject({ status: 200, data: { procedure: { id: 'turn-check' } } });
    expect(level2.checkProcedure).toHaveBeenCalledWith(TEST_USER.id, 'turn-reads');
    level2.checkProcedure.mockResolvedValueOnce(undefined);
    expect(await app.get(`${PREFIX}/scenarios/builder-saves/procedure`)).toMatchObject({ status: 404 });
  });

  it('deletes a scenario of the person\'s own, and says when they have none with that id', async () => {
    const app = await mounted();
    level2.deleteScenario.mockResolvedValueOnce(true);
    expect(await app.delete(`${PREFIX}/scenarios/mine`)).toMatchObject({ status: 200, data: { ok: true } });
    level2.deleteScenario.mockResolvedValueOnce(false);
    expect(await app.delete(`${PREFIX}/scenarios/builder-saves`)).toMatchObject({ status: 404 });
  });
});

describe('the run routes', () => {
  const run = { id: 'run-1', ownerId: TEST_USER.id, state: 'running' } as Level2Run;

  it('lists the person\'s runs and reads one, or says there is none', async () => {
    const app = await mounted();
    level2.list.mockResolvedValue([run]);
    expect(await app.get(`${PREFIX}/runs`)).toMatchObject({ data: { runs: [{ id: 'run-1' }] } });
    level2.get.mockResolvedValueOnce(run);
    expect(await app.get(`${PREFIX}/runs/run-1`)).toMatchObject({ status: 200, data: { id: 'run-1' } });
    level2.get.mockResolvedValueOnce(undefined);
    expect(await app.get(`${PREFIX}/runs/ghost`)).toMatchObject({ status: 404 });
  });

  it('starts a run on the scenarios, model and temperature named and answers 202', async () => {
    level2.start.mockResolvedValue(run);
    const reply = await (await mounted()).post(`${PREFIX}/runs`, { only: ['builder-saves'], modelId: 'tabby', modelLabel: 'Tabby', temperature: 0.4 });
    expect(reply).toMatchObject({ status: 202, data: { id: 'run-1' } });
    expect(level2.start).toHaveBeenCalledWith({
      ownerId: TEST_USER.id, only: ['builder-saves'], modelId: 'tabby', modelLabel: 'Tabby', sampling: { toolTurn: { temperature: 0.4 }, conversation: { temperature: 0.4 } },
    });
  });

  it('starts a run on everything when it is told nothing', async () => {
    level2.start.mockResolvedValue(run);
    await (await mounted()).post(`${PREFIX}/runs`);
    expect(level2.start).toHaveBeenCalledWith({ ownerId: TEST_USER.id });
  });

  it('refuses a list of scenarios that is not ids, a temperature out of range, and a scenario that does not exist', async () => {
    const app = await mounted();
    expect(await app.post(`${PREFIX}/runs`, { only: 'builder-saves' })).toMatchObject({ status: 400, data: { error: 'only has to be a list of scenario ids' } });
    expect(await app.post(`${PREFIX}/runs`, { only: [3] })).toMatchObject({ status: 400 });
    expect(await app.post(`${PREFIX}/runs`, { temperature: 9 })).toMatchObject({ status: 400, data: { error: expect.stringContaining('temperature') as unknown } });
    level2.start.mockResolvedValue({ unknown: ['ghost', 'spectre'] });
    expect(await app.post(`${PREFIX}/runs`, { only: ['ghost', 'spectre'] })).toMatchObject({ status: 400, data: { error: 'there is no scenario called "ghost", "spectre"' } });
  });

  it('compares two runs, asks which two when they are not named, and says when one is not the person\'s', async () => {
    const app = await mounted();
    level2.compare.mockResolvedValueOnce({ before: 'a', after: 'b', differences: [], checks: [], tools: [] });
    expect(await app.get(`${PREFIX}/compare?before=a&after=b`)).toMatchObject({ status: 200, data: { before: 'a', after: 'b' } });
    expect(level2.compare).toHaveBeenCalledWith(TEST_USER.id, 'a', 'b');
    expect(await app.get(`${PREFIX}/compare`)).toMatchObject({ status: 400 });
    level2.compare.mockResolvedValueOnce(undefined);
    expect(await app.get(`${PREFIX}/compare?before=a&after=ghost`)).toMatchObject({ status: 404 });
  });

  it('cancels a run that is running and says when it is not', async () => {
    const app = await mounted();
    level2.cancel.mockResolvedValueOnce(true);
    expect(await app.post(`${PREFIX}/runs/run-1/cancel`)).toMatchObject({ status: 202, data: { cancelling: true } });
    expect(level2.cancel).toHaveBeenCalledWith(TEST_USER.id, 'run-1');
    level2.cancel.mockResolvedValueOnce(false);
    expect(await app.post(`${PREFIX}/runs/run-1/cancel`)).toMatchObject({ status: 409 });
  });
});
