import { describe, it, expect } from 'vitest';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { EXAMPLE_PROCEDURE } from '@koala/agent-engine/procedure';
import type { Task } from '../../engine-host/tools/tasks.js';
import { failureMatcher, scoreScenario, type Observed, type ToolCallLog } from './score.js';

const tools = [...BUILDER_TOOLS];
const call = (name: string, ok = true, digest = ''): ToolCallLog => ({ runId: 'r', name, arguments: '{}', ok, digest });
const task = (id: string, status: Task['status']): Task => ({ id, ownerId: 'u', title: id, doneMeans: 'x', dependsOn: [], status, runs: [], createdAt: '', updatedAt: '' });

const observed = (over: Partial<Observed> = {}): Observed => ({
  outcome: 'ok', calls: [], tasks: [], counters: { rounds: 2, toolCalls: 1, totalTokens: 500 }, answer: '', saved: [], ...over,
});

describe('scoring a scenario', () => {
  it('checks the outcome, the tools called and not called, and the order they came in', async () => {
    const checks = await scoreScenario(
      { outcome: 'ok', toolsCalled: ['read_procedure'], toolsNotCalled: ['save_procedure'], toolsInOrder: ['list_references', 'read_procedure'] },
      observed({ calls: [call('list_references'), call('read_procedure')] }),
      { tools },
    );

    expect(checks.every((check) => check.passed)).toBe(true);
    expect(checks.map((check) => check.what)).toEqual(['finishes ok', 'calls read_procedure', 'never calls save_procedure', 'calls list_references then read_procedure']);
  });

  it('says what happened instead when a check does not hold', async () => {
    const checks = await scoreScenario(
      { outcome: 'ok', toolsCalled: ['save_procedure'], toolsInOrder: ['read_procedure', 'save_procedure'], within: { rounds: 1 } },
      observed({ outcome: 'failed', reason: 'it gave up', calls: [call('read_procedure')] }),
      { tools },
    );

    expect(checks).toEqual([
      { what: 'finishes ok', passed: false, detail: 'it finished failed: it gave up' },
      { what: 'calls save_procedure', passed: false, detail: 'it called read_procedure' },
      { what: 'calls read_procedure then save_procedure', passed: false, detail: 'it got as far as read_procedure, calling read_procedure' },
      { what: 'within 1 rounds', passed: false, detail: 'it used 2' },
    ]);
  });

  it('checks the tasks the world was left with', async () => {
    const checks = await scoreScenario({ tasks: [{ id: 't1', status: 'done' }, { id: 'ghost', status: 'done' }] }, observed({ tasks: [task('t1', 'failed')] }), { tools });

    expect(checks).toEqual([
      { what: 'leaves t1 done', passed: false, detail: 'it is failed' },
      { what: 'leaves ghost done', passed: false, detail: 'there is no task called ghost' },
    ]);
  });

  it('matches a declared failure whatever the run put in its blanks', () => {
    expect(failureMatcher('there is no procedure called "<id>"').test('there is no procedure called "ghost"')).toBe(true);
    expect(failureMatcher('there is no procedure called "<id>"').test('the run has no owner')).toBe(false);
  });

  it('checks the failure happened and that it was tried again', async () => {
    const digest = 'there is no procedure called "ghost"';
    const checks = await scoreScenario(
      { provokes: { tool: 'read_procedure', when: 'no procedure has that id', then: 'retried' } },
      observed({ calls: [call('read_procedure', false, digest), call('read_procedure', true, 'research: ...')] }),
      { tools },
    );

    expect(checks.map((check) => [check.what, check.passed])).toEqual([
      ['read_procedure fails when no procedure has that id', true],
      ['it tries again with what the failure told it', true],
    ]);
  });

  it('asks a model whether the answer reported the failure, and says so when it did not', async () => {
    const asked: string[] = [];
    const scoring = (answer: string, reported: boolean) => scoreScenario(
      { provokes: { tool: 'read_procedure', when: 'no procedure has that id', then: 'reported' } },
      observed({ answer, calls: [call('read_procedure', false, 'there is no procedure called "ghost"')] }),
      { tools, reported: async (says) => { asked.push(says); return reported; } },
    );

    expect((await scoring('There is no procedure called ghost.', true)).at(-1)).toMatchObject({ what: 'it tells the person what went wrong', passed: true });
    expect((await scoring('All done!', false)).at(-1)).toMatchObject({ passed: false, detail: 'its answer does not say what failed: "All done!"' });
    expect((await scoring('', true)).at(-1)).toMatchObject({ passed: false });
    expect(asked).toEqual(['there is no procedure called "<id>"', 'there is no procedure called "<id>"']);
  });
});

describe('scoring what a run left in the store', () => {
  const tidy = JSON.stringify({ ...EXAMPLE_PROCEDURE, id: 'tidy', name: 'Tidy' });

  it('passes when the named procedure is stored and checks clean', async () => {
    const checks = await scoreScenario(
      { saved: { procedure: 'tidy', stored: true } },
      observed({ saved: [{ id: 'tidy', source: tidy }] }),
      { tools },
    );

    expect(checks).toEqual([{ what: 'saves tidy, and what is stored checks clean', passed: true, detail: 'tidy is stored and checks clean' }]);
  });

  it('fails, with the problems, when what was stored does not check clean', async () => {
    const broken = JSON.stringify({ ...EXAMPLE_PROCEDURE, id: 'tidy', start: 'nowhere' });
    const [check] = await scoreScenario(
      { saved: { procedure: 'tidy', stored: true } },
      observed({ saved: [{ id: 'tidy', source: broken }] }),
      { tools },
    );

    expect(check!.passed).toBe(false);
    expect(check!.detail).toContain('does not check clean');
  });

  it('says what was saved instead when the named procedure is missing', async () => {
    const [check] = await scoreScenario(
      { saved: { procedure: 'tidy', stored: true } },
      observed({ saved: [{ id: 'other', source: tidy }] }),
      { tools },
    );

    expect(check).toMatchObject({ passed: false, detail: 'it saved other' });
  });

  it('checks that nothing was saved when the scenario says it must not be', async () => {
    const [refused, accepted] = await Promise.all([
      scoreScenario({ saved: { procedure: 'tidy', stored: false } }, observed({ saved: [{ id: 'tidy', source: tidy }] }), { tools }),
      scoreScenario({ saved: { procedure: 'tidy', stored: false } }, observed({ saved: [] }), { tools }),
    ]);

    expect(refused[0]).toMatchObject({ passed: false });
    expect(accepted[0]).toMatchObject({ passed: true });
  });
});
