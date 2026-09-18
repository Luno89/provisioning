import { describe, it, expect } from 'vitest';
import { MissingValue, fillTemplate } from './template.js';

const scope = {
  values: { item: { id: 't-42', title: 'Write hello.txt', checks: { command: 'ls' } }, goal: 'ship it' },
  text: 'what it did',
};

describe('filling a template with what the run has', () => {
  it('puts a whole value in as itself, keeping its type', () => {
    expect(fillTemplate({ taskId: '{{values.item.id}}' }, scope, 'claim')).toEqual({ taskId: 't-42' });
    expect(fillTemplate({ checks: '{{values.item.checks}}' }, scope, 'check'))
      .toEqual({ checks: { command: 'ls' } });
  });

  it('puts values inside a longer string', () => {
    expect(fillTemplate({ note: 'finished {{values.item.title}} — {{text}}' }, scope, 'record'))
      .toEqual({ note: 'finished Write hello.txt — what it did' });
  });

  it('leaves anything that is not a template alone', () => {
    expect(fillTemplate({ ready: true, limit: 5, status: 'accepted' }, scope, 'gather'))
      .toEqual({ ready: true, limit: 5, status: 'accepted' });
  });

  it('fills templates nested in objects and arrays', () => {
    expect(fillTemplate({ deep: { list: ['{{values.goal}}'] } }, scope, 'plan'))
      .toEqual({ deep: { list: ['ship it'] } });
  });

  it('refuses a value the run was never given, and says which one', () => {
    expect(() => fillTemplate({ goal: '{{values.goal.missing}}' }, scope, 'plan'))
      .toThrow(/plan needs values\.goal\.missing, which this run was not given/);
  });

  it('refuses a missing value inside a longer string too, rather than leaving a gap', () => {
    expect(() => fillTemplate({ note: 'about {{values.nothing}} here' }, scope, 'record'))
      .toThrow(MissingValue);
  });

  it('names the path on the error, so a caller can say what to send', () => {
    try {
      fillTemplate({ goal: '{{values.goal2}}' }, scope, 'plan');
      expect.unreachable('it should have refused');
    } catch (err) {
      expect((err as MissingValue).path).toBe('values.goal2');
    }
  });

  it('has nothing to fill when there are no arguments', () => {
    expect(fillTemplate(undefined, scope, 'gather')).toEqual({});
  });
});
