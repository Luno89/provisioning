import { describe, it, expect } from 'vitest';
import type { RecipeNode } from './tree-types.js';
import {
  findRecipeNode, parentIdOfRecipeNode, childrenOfRecipeNode, updateRecipeNode, removeRecipeNode,
  insertRecipeNode, reorderRecipeChildren, clearRecipeRunIfReferences, preOrderRecipeNodes,
} from './recipe-tree-ops.js';

const leaf = (id: string, extra: Partial<RecipeNode> = {}): RecipeNode => (
  { id, name: id, type: 'run-command', command: 'true', ...extra } as RecipeNode
);

const group = (id: string, children: RecipeNode[]): RecipeNode => (
  { id, name: id, containerType: 'group', children }
);

describe('findRecipeNode', () => {
  it('finds a top-level and a nested node', () => {
    const tree = [leaf('a'), group('g', [leaf('b')])];
    expect(findRecipeNode(tree, 'a')?.id).toBe('a');
    expect(findRecipeNode(tree, 'b')?.id).toBe('b');
    expect(findRecipeNode(tree, 'ghost')).toBeUndefined();
  });
});

describe('parentIdOfRecipeNode', () => {
  it('is null at top level, the container id when nested, undefined when absent', () => {
    const tree = [leaf('a'), group('g', [leaf('b')])];
    expect(parentIdOfRecipeNode(tree, 'a')).toBeNull();
    expect(parentIdOfRecipeNode(tree, 'b')).toBe('g');
    expect(parentIdOfRecipeNode(tree, 'ghost')).toBeUndefined();
  });
});

describe('childrenOfRecipeNode', () => {
  it('null returns the top level, a container id returns its children, a leaf id returns undefined', () => {
    const tree = [leaf('a'), group('g', [leaf('b')])];
    expect(childrenOfRecipeNode(tree, null)?.map((n) => n.id)).toEqual(['a', 'g']);
    expect(childrenOfRecipeNode(tree, 'g')?.map((n) => n.id)).toEqual(['b']);
    expect(childrenOfRecipeNode(tree, 'a')).toBeUndefined();
  });
});

describe('updateRecipeNode', () => {
  it('patches a nested node immutably', () => {
    const tree = [group('g', [leaf('a'), leaf('b')])];
    const next = updateRecipeNode(tree, 'b', (n) => ({ ...n, name: 'renamed' }));
    const g = next[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.name)).toEqual(['a', 'renamed']);
    expect((tree[0] as typeof g).children[1]!.name).toBe('b');
  });
});

describe('removeRecipeNode', () => {
  it('removes a nested node, keeping its siblings', () => {
    const tree = [group('g', [leaf('a'), leaf('b')])];
    const { nodes, removed } = removeRecipeNode(tree, 'a');
    const g = nodes[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b']);
    expect(removed?.id).toBe('a');
  });

  it('removed is undefined for an id that does not exist', () => {
    expect(removeRecipeNode([leaf('a')], 'ghost').removed).toBeUndefined();
  });
});

describe('insertRecipeNode', () => {
  it('inserts at the top level and into a container', () => {
    const top = insertRecipeNode([leaf('a')], null, 1, leaf('b'));
    expect(top.map((n) => n.id)).toEqual(['a', 'b']);

    const nested = insertRecipeNode([group('g', [leaf('a')])], 'g', 0, leaf('b'));
    const g = nested[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('reorderRecipeChildren', () => {
  it('reorders a level given every id in the new order', () => {
    const tree = [leaf('a'), leaf('b'), leaf('c')];
    const next = reorderRecipeChildren(tree, null, ['c', 'a', 'b']);
    expect(next?.map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorders a nested container\'s children', () => {
    const tree = [group('g', [leaf('a'), leaf('b')])];
    const next = reorderRecipeChildren(tree, 'g', ['b', 'a']);
    const g = next?.[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('refuses a list missing an existing id', () => {
    const tree = [leaf('a'), leaf('b')];
    expect(reorderRecipeChildren(tree, null, ['a'])).toBeUndefined();
  });

  it('refuses a list naming an id not at that level', () => {
    const tree = [leaf('a'), leaf('b')];
    expect(reorderRecipeChildren(tree, null, ['a', 'ghost'])).toBeUndefined();
  });

  it('refuses an unknown parentId', () => {
    expect(reorderRecipeChildren([leaf('a')], 'ghost', [])).toBeUndefined();
  });
});

describe('clearRecipeRunIfReferences', () => {
  it('clears a top-level and a nested runIf pointing at the removed id', () => {
    const tree = [
      leaf('b', { runIf: 'a' } as Partial<RecipeNode>),
      group('g', [leaf('c', { runIf: 'a' } as Partial<RecipeNode>)]),
    ];
    const next = clearRecipeRunIfReferences(tree, 'a');
    expect(next[0]!.runIf).toBeUndefined();
    const g = next[1] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children[0]!.runIf).toBeUndefined();
  });

  it('leaves an unrelated runIf untouched', () => {
    const tree = [leaf('a'), leaf('b', { runIf: 'a' } as Partial<RecipeNode>)];
    expect(clearRecipeRunIfReferences(tree, 'ghost')[1]!.runIf).toBe('a');
  });
});

describe('preOrderRecipeNodes', () => {
  it('visits a container before its children', () => {
    const tree = [leaf('a'), group('g', [leaf('b'), leaf('c')]), leaf('d')];
    expect(preOrderRecipeNodes(tree).map((n) => n.id)).toEqual(['a', 'g', 'b', 'c', 'd']);
  });
});
