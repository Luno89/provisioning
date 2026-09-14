import { describe, it, expect } from 'vitest';
import { resolveArgs } from './builtins.js';

const scope = {
  inputs: {
    item: {
      id: 't-42',
      title: 'Fix the database host',
      checks: { command: 'npm test' },
    },
  },
  reply: { content: 'all done' },
  counters: { rounds: 3 },
};

describe('argument templating', () => {
  it('substitutes a whole value, keeping its type', () => {
    expect(resolveArgs({ taskId: '{{inputs.item.id}}' }, scope)).toEqual({ taskId: 't-42' });
    expect(resolveArgs({ rounds: '{{counters.rounds}}' }, scope)).toEqual({ rounds: 3 });
  });

  it('pulls a check command off the task rather than the graph', () => {
    expect(resolveArgs({ command: '{{inputs.item.checks.command}}' }, scope))
      .toEqual({ command: 'npm test' });
  });

  it('interpolates inside a longer string', () => {
    expect(resolveArgs({ note: 'finished {{inputs.item.title}} in {{counters.rounds}} rounds' }, scope))
      .toEqual({ note: 'finished Fix the database host in 3 rounds' });
  });

  it('leaves plain values alone', () => {
    expect(resolveArgs({ status: 'accepted', ready: true, limit: 5 }, scope))
      .toEqual({ status: 'accepted', ready: true, limit: 5 });
  });

  it('resolves inside nested objects and arrays', () => {
    expect(resolveArgs({
      nested: { taskId: '{{inputs.item.id}}' },
      list: ['{{inputs.item.id}}', 'literal'],
    }, scope)).toEqual({
      nested: { taskId: 't-42' },
      list: ['t-42', 'literal'],
    });
  });

  it('gives undefined for a path that is not there, rather than the template text', () => {
    expect(resolveArgs({ missing: '{{inputs.item.nope}}' }, scope)).toEqual({ missing: undefined });
  });

  it('renders a missing path as empty when interpolating into a sentence', () => {
    expect(resolveArgs({ note: 'value is [{{inputs.item.nope}}]' }, scope))
      .toEqual({ note: 'value is []' });
  });

  it('tolerates no arguments at all', () => {
    expect(resolveArgs(undefined, scope)).toEqual({});
  });

  it('ignores whitespace inside the braces', () => {
    expect(resolveArgs({ taskId: '{{ inputs.item.id }}' }, scope)).toEqual({ taskId: 't-42' });
  });
});
