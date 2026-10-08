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

describe('scoring hand-offs and files', () => {
  const handOff = (agent: string, startedAt: number, finishedAt: number) => ({ agent, startedAt, finishedAt, outcome: 'ok' });

  it('checks how many times work was handed to an agent, and whether those runs went at once', async () => {
    const together = await scoreScenario(
      { handOffs: [{ agent: 'research', atLeast: 2, atMost: 3, together: true }] },
      observed({ handOffs: [handOff('research', 0, 10), handOff('research', 1, 12), handOff('planner', 20, 30)] }),
      { tools },
    );
    expect(together.map((check) => [check.what, check.passed])).toEqual([
      ['hands work to research at least 2 times', true],
      ['hands work to research at most 3 times', true],
      ['hands work to research several at once', true],
    ]);

    const oneAfterAnother = await scoreScenario(
      { handOffs: [{ agent: 'research', together: true }] },
      observed({ handOffs: [handOff('research', 0, 10), handOff('research', 11, 20)] }),
      { tools },
    );
    expect(oneAfterAnother).toEqual([{ what: 'hands work to research several at once', passed: false, detail: '0 of its 2 hand-offs to research ran at the same time as another' }]);
  });

  it('checks a file was written and says what it is missing', async () => {
    const checks = await scoreScenario(
      { files: [{ path: 'findings.md', contains: ['5432', 'source'] }, { path: 'missing.md' }] },
      observed({ files: { 'findings.md': 'PostgreSQL listens on 5432.', 'missing.md': null } }),
      { tools },
    );

    expect(checks).toEqual([
      { what: 'writes findings.md saying 5432, source', passed: false, detail: 'findings.md does not mention source: "PostgreSQL listens on 5432."' },
      { what: 'writes missing.md', passed: false, detail: 'there is no missing.md in its workspace' },
    ]);
  });
});

describe('a tool that has to work, not just be called', () => {
  it('passes once a call worked, and otherwise says what the last refusal said', async () => {
    const worked = await scoreScenario({ toolsSucceeded: ['propose_plan'] }, observed({ calls: [call('propose_plan', false, 'not a JSON list'), call('propose_plan', true)] }), { tools });
    expect(worked).toEqual([{ what: 'calls propose_plan and it works', passed: true, detail: 'propose_plan worked on the 2nd try' }]);

    const refused = await scoreScenario({ toolsSucceeded: ['propose_plan'] }, observed({ calls: [call('propose_plan', false, 'branches has to be a list'), call('propose_plan', false, 'JSON parse error at 3135')] }), { tools });
    expect(refused).toEqual([{ what: 'calls propose_plan and it works', passed: false, detail: '2 calls to propose_plan, none worked; the last said: JSON parse error at 3135' }]);
  });
});

describe('checks on the plumbing a flow goes through', () => {
  it('reads what the model was sent, the summary, the turn log, the leaves, main, the pull requests and the workspace', async () => {
    const checks = await scoreScenario({
      modelSaw: { contains: ['Summary of the conversation'], lacks: ['Remember this code word'] },
      compacted: false,
      turnLog: { complete: true },
      leaves: { verified: 2, landed: { Alpha: 'merged', Gamma: 'nothing' }, mergeTasks: 1 },
      repository: { of: 'tree', files: [{ path: 'shared.txt', contains: ['alpha', 'beta'] }] },
      pullRequests: { merged: 2, open: 0 },
      workspace: { of: 'tree', exists: false },
    }, observed({ flow: {
      modelRequests: ['first: Remember this code word', 'later: Summary of the conversation so far'],
      compacted: false,
      turnLog: { contiguous: true, savedMatches: true, entries: 40 },
      leaves: [{ title: 'Alpha', status: 'succeeded', verified: true, landed: 'merged' }, { title: 'Gamma', status: 'succeeded', verified: true, landed: 'nothing' }],
      mergeTasks: 1,
      repository: { 'shared.txt': 'alpha\nbeta\n' },
      pullRequests: { merged: 2, open: 0, closedUnmerged: 1 },
      workspaceExists: false,
    } }), { tools });

    expect(checks.filter((check) => !check.passed)).toEqual([]);
    expect(checks).toHaveLength(12);
  });

  it('reads what a failed leaf\'s findings say and whether the browser files it left open', async () => {
    const leaf = { title: 'Probe', status: 'failed', verified: false, findings: 'odoo-e2e: FAILED\nwhat the browser left behind:' };
    const expectation = { leaves: { findings: { Probe: ['odoo-e2e: FAILED', 'what the browser left behind'] }, artifacts: { Probe: 2 } } };

    const passing = await scoreScenario(expectation, observed({ flow: { leaves: [{ ...leaf, artifacts: [
      { name: 'shot.png', opens: true, contentType: 'image/png', size: 900 },
      { name: 'trace.zip', opens: true, contentType: 'application/zip', size: 4000 },
    ] }] } }), { tools });
    expect(passing.filter((check) => !check.passed)).toEqual([]);

    const failing = await scoreScenario(expectation, observed({ flow: { leaves: [{ ...leaf, findings: 'odoo-e2e: FAILED', artifacts: [
      { name: 'shot.png', opens: true, contentType: 'image/png', size: 900 },
      { name: 'trace.zip', opens: false },
    ] }] } }), { tools });
    expect(failing.filter((check) => !check.passed).map((check) => check.detail)).toEqual([
      'they do not say "what the browser left behind": odoo-e2e: FAILED',
      '1 of 2 open: shot.png (image/png, 900 bytes); trace.zip does not open',
    ]);
  });

  it('says what it found instead when the plumbing let something through', async () => {
    const checks = await scoreScenario(
      { repository: { of: 'tree', files: [{ path: 'shared.txt', contains: ['beta'] }] }, turnLog: { complete: true }, workspace: { of: 'conversation', exists: false } },
      observed({ flow: { repository: { 'shared.txt': 'alpha\n' }, turnLog: { contiguous: false, savedMatches: true, entries: 12 }, workspaceExists: true } }),
      { tools },
    );
    expect(checks.map((check) => check.detail)).toEqual([
      'the turn log\'s 12 entries have a gap',
      'shared.txt on main does not say beta: "alpha\n"',
      'it is there',
    ]);
  });
});
