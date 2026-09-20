import { describe, it, expect } from 'vitest';
import { missingGrants, requiredGrants } from './required.js';
import { DO_ONE_TASK_V2, TOOL_ROUNDS_V2 } from './seeds/procedures.js';
import { BUILT_IN_GROUPS } from './seeds/groups.js';

describe('what a procedure requires of whoever runs it', () => {
  it('names every tool it calls and every persona it hands work to', () => {
    const required = requiredGrants(DO_ONE_TASK_V2, BUILT_IN_GROUPS);

    expect(required.map((entry) => [entry.name, entry.kind])).toEqual([
      ['judge', 'agent'],
      ['mark_done', 'tool'],
      ['mark_failed', 'tool'],
      ['run_command', 'tool'],
      ['start_task', 'tool'],
    ]);
  });

  it('says why each one is needed, using the step’s own words when it has them', () => {
    const required = requiredGrants(DO_ONE_TASK_V2, BUILT_IN_GROUPS);

    expect(required.find((entry) => entry.name === 'start_task')!.why)
      .toBe('The task has already been claimed for you.');
    expect(required.find((entry) => entry.name === 'run_command')!.why)
      .toBe('the "check" step calls it');
  });

  it('requires nothing of a procedure that only lets the model choose', () => {
    expect(requiredGrants(TOOL_ROUNDS_V2, BUILT_IN_GROUPS)).toEqual([]);
  });

  it('requires nothing when there is no procedure', () => {
    expect(requiredGrants(undefined)).toEqual([]);
  });
});

describe('what a persona is missing for the procedure it runs', () => {
  it('lists the grants that are not there', () => {
    const missing = missingGrants(
      DO_ONE_TASK_V2,
      { tools: ['run_command', 'start_task'], agents: [] },
      BUILT_IN_GROUPS,
    );

    expect(missing.map((entry) => entry.name)).toEqual(['judge', 'mark_done', 'mark_failed']);
  });

  it('is happy once everything it drives is granted', () => {
    const missing = missingGrants(
      DO_ONE_TASK_V2,
      { tools: ['start_task', 'mark_done', 'mark_failed', 'run_command'], agents: ['judge'] },
      BUILT_IN_GROUPS,
    );

    expect(missing).toEqual([]);
  });
});
