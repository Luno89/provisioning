import { describe, it, expect } from 'vitest';
import { serialiseBoard, boardFile, BOARD_PATH } from './planning-board.js';
import type { Leaf } from './leaves.js';
import type { Persona } from '@koala/harness-types';

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 't', column: 'todo', status: 'proposed',
  depth: 0, blocking: true, createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z',
  ...over,
} as Leaf);

const persona = (id: string, name: string): Persona =>
  ({ id, ownerId: 'u1', name, createdAt: 'x', updatedAt: 'x' });

describe('serialiseBoard', () => {
  it('resolves dependencies back to titles, so a predicate never joins a uuid', () => {
    const base = leaf({ id: 'a', title: 'Build the client' });
    const next = leaf({ id: 'b', title: 'Test it', dependsOn: ['a'], createdAt: '2026-08-07T00:00:01.000Z' });

    expect(serialiseBoard([base, next])[1]!.dependsOn).toEqual(['Build the client']);
  });

  it('resolves the persona to the name the model assigned it by', () => {
    const assigned = leaf({ packId: 'p1' });
    expect(serialiseBoard([assigned], [persona('p1', 'Coder')])[0]!.persona).toBe('Coder');
  });

  it('reports null rather than an id when a persona was never assigned', () => {
    expect(serialiseBoard([leaf({})])[0]!.persona).toBeNull();
  });

  it('drops a dependency whose target no longer exists', () => {
    expect(serialiseBoard([leaf({ dependsOn: ['deleted'] })])[0]!.dependsOn).toEqual([]);
  });

  it('keeps the order the model proposed them in', () => {
    const second = leaf({ id: 'b', title: 'second', createdAt: '2026-08-07T00:00:02.000Z' });
    const first = leaf({ id: 'a', title: 'first', createdAt: '2026-08-07T00:00:01.000Z' });

    expect(serialiseBoard([second, first]).map((b) => b.title)).toEqual(['first', 'second']);
  });

  it('carries none of the record keeping a predicate has no business reading', () => {
    const rich = leaf({ workflowId: 'wf-1', packId: 'p1' });
    const [entry] = serialiseBoard([rich], [persona('p1', 'Coder')]);

    expect(Object.keys(entry!).sort()).toEqual(
      ['body', 'dependsOn', 'parent', 'persona', 'title'],
    );
  });
});

describe('boardFile', () => {
  it('writes readable JSON, because a failing task is read by a human first', () => {
    const file = boardFile([leaf({ title: 'A' })]);
    expect(file.path).toBe(BOARD_PATH);
    expect(file.content.split('\n').length).toBeGreaterThan(3);
    expect(JSON.parse(file.content)[0].title).toBe('A');
  });

  it('writes an empty array when nothing was proposed', () => {
    expect(JSON.parse(boardFile([]).content)).toEqual([]);
  });
});

describe('the gate baseline', () => {
  it('an empty board is what a planning verify must fail on', () => {
    const empty = JSON.parse(boardFile([]).content);
    expect(Array.isArray(empty)).toBe(true);
    expect(empty).toHaveLength(0);
  });
});
