import { describe, it, expect } from 'vitest';
import type { Leaf } from './leaves.js';
import type { Task } from './tasks.js';
import { applyChange, briefIn, changeSummary, parseCancel, parseNewStories, parseStoryEdit, renderChangeNote, runsToStop, withWaitsOn, type ChangeWorld } from './item-changes.js';

const leaf = (id: string, status: Leaf['status'], extra: Partial<Leaf> = {}): Leaf => ({
  id, ownerId: 'u1', branchId: 'b1', title: `Story ${id}`, body: `Goal of ${id}`, status, createdAt: 't', updatedAt: 't', ...extra,
});
const task = (id: string, leafId: string, status: Task['status']): Task => ({
  id, ownerId: 'u1', leafId, title: `Task ${id}`, doneMeans: 'it works', dependsOn: [], status, runs: [], createdAt: 't', updatedAt: 't',
});
const newTask = { key: 'print', title: 'Print the note', description: 'Add the note to the printed order report.', role: 'Customers see the note on paper.', doneMeans: 'The PDF shows the note.' };
const world = (leaves: Leaf[], tasks: Task[] = []): ChangeWorld => ({ treeId: 't1', leaves, tasks });
const at = { proposalId: 'p9', at: '2026-10-10T12:00:00Z' };

describe('changing a story', () => {
  it('refuses a shipped story and says to propose a follow-up instead', () => {
    const parsed = parseStoryEdit({ why: 'also print it', body: 'New goal' }, 'l1', world([leaf('l1', 'succeeded', { verified: true })]));
    expect(parsed).toEqual({ problem: expect.stringContaining('propose_stories, waiting on l1') });
  });

  it('refuses a change that changes nothing, a rework of untried work, and waits that go in a circle', () => {
    const stories = [leaf('l1', 'pending'), leaf('l2', 'pending', { dependsOn: ['l1'] })];
    expect(parseStoryEdit({ why: 'w', title: 'Story l1' }, 'l1', world(stories))).toEqual({ problem: expect.stringContaining('nothing would change') });
    expect(parseStoryEdit({ why: 'w', rework: true }, 'l1', world(stories))).toEqual({ problem: expect.stringContaining('nothing to rework') });
    expect(parseStoryEdit({ why: 'w', dependsOn: ['l2'] }, 'l1', world(stories))).toEqual({ problem: expect.stringContaining('circle') });
  });

  it('restarts a running story whose brief changes: its run is stopped, the attempt kept with the run, its stuck tasks handed back', () => {
    const running = leaf('l1', 'running', { runId: 'run-1' });
    const tasks = [task('k1', 'l1', 'done'), task('k2', 'l1', 'running')];
    const parsed = parseStoryEdit({ why: 'print it too', body: 'The note is on screen and on paper', addTasks: [newTask] }, 'l1', world([running], tasks));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(parsed.change.outcome[0]).toContain('The worker on it now is stopped');
    expect(runsToStop(parsed.change, [running])).toEqual(['run-1']);

    const applied = applyChange(parsed.change, world([running], tasks), at);
    const saved = applied.leaves[0]!;
    expect(saved).toMatchObject({ status: 'pending', body: 'The note is on screen and on paper', tasks: ['k1', 'k2', 'plan-p9-t0'] });
    expect(saved.runId).toBeUndefined();
    expect(saved.attempts).toEqual([{ attempt: 1, error: 'stopped and started again: print it too', failedAt: at.at, runId: 'run-1', change: 'p9' }]);
    expect(applied.tasks.map((entry) => [entry.id, entry.status])).toEqual([['k2', 'accepted'], ['plan-p9-t0', 'accepted']]);
    expect(applied.grow).toBe(true);
  });

  it('lets a running story carry on when only tasks are added, and leaves a waiting one waiting', () => {
    const running = leaf('l1', 'running', { runId: 'run-1' });
    const parsed = parseStoryEdit({ why: 'more to do', addTasks: [newTask] }, 'l1', world([running]));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(runsToStop(parsed.change, [running])).toEqual([]);
    const applied = applyChange(parsed.change, world([running]), at);
    expect(applied.leaves[0]).toMatchObject({ status: 'running', runId: 'run-1' });
    expect(applied.grow).toBe(false);

    const waiting = parseStoryEdit({ why: 'clearer', title: 'Clearer title' }, 'l1', world([leaf('l1', 'pending')]));
    if (!('change' in waiting)) throw new Error(waiting.problem);
    expect(waiting.change.outcome[0]).toContain('still waiting');
    expect(applyChange(waiting.change, world([leaf('l1', 'pending')]), at).leaves[0]).toMatchObject({ status: 'pending', title: 'Clearer title' });
  });

  it('reworks a failed story, keeping why it failed, and does it only once when applied again', () => {
    const failed = leaf('l1', 'failed', { findings: 'the view did not load' });
    const parsed = parseStoryEdit({ why: 'try the inherited view', rework: true }, 'l1', world([failed]));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(changeSummary(parsed.change)).toBe('Rework “Story l1”');
    const once = applyChange(parsed.change, world([failed]), at).leaves[0]!;
    expect(once.status).toBe('pending');
    expect(once.attempts?.[0]?.error).toBe('reworked: try the inherited view — it had failed: the view did not load');
    const twice = applyChange(parsed.change, world([once]), at);
    expect(twice.leaves[0]!.attempts).toHaveLength(1);
    expect(twice.grow).toBe(true);
  });

  it('keeps a failed story failed when only its brief changes', () => {
    const parsed = parseStoryEdit({ why: 'sharper', brief: 'Use the inherited form view.' }, 'l1', world([leaf('l1', 'failed')]));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(parsed.change.outcome[0]).toContain('stays failed');
    expect(applyChange(parsed.change, world([leaf('l1', 'failed')]), at).leaves[0]!.status).toBe('failed');
  });

  it('refuses dropping a task being worked unless the story starts again', () => {
    const stories = [leaf('l1', 'running', { runId: 'r' })];
    const tasks = [task('k1', 'l1', 'running')];
    expect(parseStoryEdit({ why: 'w', dropTasks: ['k1'] }, 'l1', world(stories, tasks))).toEqual({ problem: expect.stringContaining('add rework') });
    expect('change' in parseStoryEdit({ why: 'w', dropTasks: ['k1'], rework: true }, 'l1', world(stories, tasks))).toBe(true);
  });

  it('refuses applying once the story shipped after it was proposed', () => {
    const parsed = parseStoryEdit({ why: 'w', title: 'New' }, 'l1', world([leaf('l1', 'pending')]));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(() => applyChange(parsed.change, world([leaf('l1', 'succeeded')]), at)).toThrow('has shipped');
  });
});

describe('adding stories to a feature', () => {
  it('adds them waiting, with their tasks, waiting on a shipped story or each other', () => {
    const parsed = parseNewStories({
      why: 'print the note too',
      stories: [
        { key: 'print', title: 'Printed note', body: 'The order PDF shows the note', brief: 'Inherit the report.', dependsOn: ['l1'], tasks: [newTask] },
        { key: 'mail', title: 'Mailed note', body: 'The order email shows the note', brief: 'Inherit the mail template.', dependsOn: ['print'] },
      ],
    }, { id: 'b1', title: 'The field' }, world([leaf('l1', 'succeeded')]));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(parsed.change.outcome[1]).toContain('One has no tasks yet');
    expect(changeSummary(parsed.change)).toBe('Add 2 stories to “The field”');

    const applied = applyChange(parsed.change, world([leaf('l1', 'succeeded')]), at);
    expect(applied.leaves.map((entry) => [entry.id, entry.status, entry.dependsOn, entry.tasks])).toEqual([
      ['plan-p9-l0', 'pending', ['l1'], ['plan-p9-l0-t0']],
      ['plan-p9-l1', 'pending', ['plan-p9-l0'], []],
    ]);
    expect(applied.grow).toBe(true);
    expect(applyChange(parsed.change, world([leaf('l1', 'succeeded'), ...applied.leaves]), at).leaves).toEqual([]);
  });

  it('makes every new story wait on the stories named for all of them, as a follow-up waits on what shipped', () => {
    const parsed = parseNewStories({ why: 'w', dependsOn: ['l1'], stories: [{ key: 'print', title: 'Printed note', body: 'B', brief: 'C' }] }, { id: 'b1', title: 'The field' }, world([leaf('l1', 'succeeded')]));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(parsed.change.add?.leaves[0]?.dependsOn).toEqual(['l1']);
    expect(parsed.change.names).toEqual({ l1: 'Story l1' });
    expect(parsed.change.outcome[0]).toBe('The story is added to “The field”, waiting, with its brief in leaves/ and listed in PLAN.md.');
  });

  it('refuses a story without a brief, or one waiting on something that does not exist', () => {
    const branch = { id: 'b1', title: 'F' };
    expect(parseNewStories({ why: 'w', stories: [{ title: 'A', body: 'B' }] }, branch, world([]))).toEqual({ problem: expect.stringContaining('needs a brief') });
    expect(parseNewStories({ why: 'w', stories: [{ title: 'A', body: 'B', brief: 'C', dependsOn: ['nope'] }] }, branch, world([]))).toEqual({ problem: expect.stringContaining('neither a new story') });
  });
});

describe('cancelling stories', () => {
  it('stops a running one, drops its unfinished tasks and frees what waited on it', () => {
    const stories = [leaf('l1', 'running', { runId: 'run-1' }), leaf('l2', 'pending', { dependsOn: ['l1', 'l3'] }), leaf('l3', 'succeeded')];
    const tasks = [task('k1', 'l1', 'done'), task('k2', 'l1', 'running')];
    const parsed = parseCancel({ why: 'not wanted' }, ['l1'], world(stories, tasks));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    expect(parsed.change.outcome).toEqual([
      'The worker on “Story l1” is stopped.',
      'It is cancelled: kept on record, off the board\'s columns, never worked again.',
      '“Story l2” no longer waits on “Story l1”.',
      'PLAN.md notes the cancellation.',
    ]);
    expect(runsToStop(parsed.change, stories)).toEqual(['run-1']);
    const applied = applyChange(parsed.change, world(stories, tasks), at);
    expect(applied.leaves.map((entry) => [entry.id, entry.status, entry.dependsOn])).toEqual([['l1', 'cancelled', undefined], ['l2', 'pending', ['l3']]]);
    expect(applied.tasks.map((entry) => [entry.id, entry.status])).toEqual([['k2', 'dropped']]);
    expect(applied.grow).toBe(false);
  });

  it('refuses a shipped story', () => {
    expect(parseCancel({ why: 'w' }, ['l1'], world([leaf('l1', 'succeeded')]))).toEqual({ problem: expect.stringContaining('has shipped') });
  });
});

describe('the documents a change rewrites', () => {
  it('reads the brief back out of a story\'s file and rewrites what it waits on', () => {
    const document = '# T\n\nLeaf `l1`\n\n## The goal the judge checks\n\nG\n\nWaits on: `l0`\n\n## Brief\n\nUse the form view.\n\n## Tasks\n\nNone\n';
    expect(briefIn(document)).toBe('Use the form view.');
    expect(withWaitsOn(document, [])).toContain('Waits on: nothing');
  });

  it('notes the change in PLAN.md after what was there', () => {
    const parsed = parseCancel({ why: 'not wanted' }, ['l1'], world([leaf('l1', 'pending')]));
    if (!('change' in parsed)) throw new Error(parsed.problem);
    const note = renderChangeNote('# Plan\n', parsed.change, { leafIds: {}, taskIds: {} }, 'p9', () => 'Story l1');
    expect(note).toBe('# Plan\n\n---\n\n## Changed: Cancel “Story l1” (change `p9`)\n\nnot wanted\n\n- **Story l1** (`l1`): cancelled\n');
  });
});
