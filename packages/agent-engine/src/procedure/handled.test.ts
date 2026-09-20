import { describe, it, expect } from 'vitest';
import { describeHandledSteps, handledSteps, handledTools } from './handled.js';
import type { PlacedNode } from './schema.js';

const node = (over: Partial<PlacedNode> & Pick<PlacedNode, 'id' | 'kind'>): PlacedNode => ({
  settings: {},
  position: [0, 0] as unknown as PlacedNode['position'],
  ...over,
});

const procedure = (nodes: PlacedNode[]) => ({ nodes });

describe('the steps a procedure does for the model', () => {
  it('finds the tool calls marked as the procedure’s job', () => {
    const found = handledSteps(procedure([
      node({ id: 'claim', kind: 'call-tool', settings: { tool: 'start_task', handles: true, says: 'The task has already been claimed for you.' } }),
      node({ id: 'check', kind: 'call-tool', settings: { tool: 'run_command' } }),
      node({ id: 'turn', kind: 'call-model' }),
    ]));

    expect(found).toEqual([
      { node: 'claim', tool: 'start_task', says: 'The task has already been claimed for you.' },
    ]);
  });

  it('leaves a tool the procedure calls without claiming it alone', () => {
    const found = handledTools(procedure([
      node({ id: 'check', kind: 'call-tool', settings: { tool: 'run_command' } }),
    ]));

    expect(Object.keys(found)).toEqual([]);
  });

  it('ignores a step that claims the job but names no tool', () => {
    expect(handledSteps(procedure([node({ id: 'broken', kind: 'call-tool', settings: { handles: true } })]))).toEqual([]);
  });

  it('falls back to naming the tool when the step says nothing', () => {
    const found = handledTools(procedure([
      node({ id: 'record', kind: 'call-tool', settings: { tool: 'mark_done', handles: true } }),
    ]));

    expect(found.mark_done).toBe('the procedure calls mark_done for you');
  });

  it('joins two steps that handle the same tool differently', () => {
    const found = handledTools(procedure([
      node({ id: 'rejected', kind: 'call-tool', settings: { tool: 'mark_failed', handles: true, says: 'A rejected verdict is recorded for you.' } }),
      node({ id: 'unjudged', kind: 'call-tool', settings: { tool: 'mark_failed', handles: true, says: 'Work that could not be judged is recorded for you.' } }),
    ]));

    expect(found.mark_failed).toBe('A rejected verdict is recorded for you. Work that could not be judged is recorded for you.');
  });

  it('says the same thing once when two steps say it identically', () => {
    const found = handledTools(procedure([
      node({ id: 'a', kind: 'call-tool', settings: { tool: 'mark_failed', handles: true, says: 'The outcome is recorded for you.' } }),
      node({ id: 'b', kind: 'call-tool', settings: { tool: 'mark_failed', handles: true, says: 'The outcome is recorded for you.' } }),
    ]));

    expect(found.mark_failed).toBe('The outcome is recorded for you.');
  });
});

describe('telling the model what happens around it', () => {
  it('writes a section naming each thing done for it', () => {
    const text = describeHandledSteps(procedure([
      node({ id: 'claim', kind: 'call-tool', settings: { tool: 'start_task', handles: true, says: 'The task has already been claimed for you.' } }),
      node({ id: 'record', kind: 'call-tool', settings: { tool: 'mark_done', handles: true, says: 'The outcome is recorded for you.' } }),
    ]));

    expect(text).toBe([
      'WHAT THE PROCEDURE DOES AROUND YOU',
      '',
      '- The task has already been claimed for you.',
      '- The outcome is recorded for you.',
    ].join('\n'));
  });

  it('says nothing at all when the procedure handles nothing', () => {
    expect(describeHandledSteps(procedure([node({ id: 'turn', kind: 'call-model' })]))).toBe('');
  });

  it('says nothing when there is no procedure to read', () => {
    expect(describeHandledSteps(undefined)).toBe('');
  });
});

describe('a persona the procedure hands work to itself', () => {
  it('is found the same way a tool is, by the agent it names', () => {
    const found = handledTools(procedure([
      node({ id: 'judge', kind: 'delegate', settings: { agent: 'judge', handles: true, says: 'A judge weighs your work when you finish.' } }),
    ]));

    expect(found.judge).toBe('A judge weighs your work when you finish.');
  });

  it('is left offered when the step does not claim the job', () => {
    const found = handledTools(procedure([
      node({ id: 'judge', kind: 'delegate', settings: { agent: 'judge' } }),
    ]));

    expect(found.judge).toBeUndefined();
  });

  it('ignores a kind of step that hands nothing over', () => {
    expect(handledSteps(procedure([node({ id: 'x', kind: 'fan-out', settings: { agent: 'judge', handles: true } })]))).toEqual([]);
  });
});
