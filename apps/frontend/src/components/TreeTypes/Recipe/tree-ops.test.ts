import { describe, it, expect } from 'vitest';
import type { RecipeNode } from '../shared.js';
import {
  findNode, parentIdOf, childrenOf, updateNode, removeNode, insertNode, moveNode,
  subtreeContainsId, preOrder, nodesBefore, clearRunIfReferences,
} from './tree-ops.js';

const leaf = (id: string, extra: Partial<RecipeNode> = {}): RecipeNode => (
  { id, name: id, type: 'run-command', command: 'true', ...extra } as RecipeNode
);

const group = (id: string, children: RecipeNode[]): RecipeNode => (
  { id, name: id, containerType: 'group', children }
);

describe('findNode', () => {
  it('finds a top-level node', () => {
    const tree = [leaf('a'), leaf('b')];
    expect(findNode(tree, 'b')?.id).toBe('b');
  });

  it('finds a node nested inside a group', () => {
    const tree = [group('g', [leaf('a'), leaf('b')])];
    expect(findNode(tree, 'b')?.id).toBe('b');
  });

  it('returns undefined for an id that does not exist', () => {
    expect(findNode([leaf('a')], 'ghost')).toBeUndefined();
  });
});

describe('parentIdOf', () => {
  it('is null for a top-level node', () => {
    expect(parentIdOf([leaf('a')], 'a')).toBeNull();
  });

  it('is the container id for a nested node', () => {
    const tree = [group('g', [leaf('a')])];
    expect(parentIdOf(tree, 'a')).toBe('g');
  });

  it('is undefined when the id is not in the tree', () => {
    expect(parentIdOf([leaf('a')], 'ghost')).toBeUndefined();
  });
});

describe('childrenOf', () => {
  it('null container id returns the top-level array', () => {
    const tree = [leaf('a'), leaf('b')];
    expect(childrenOf(tree, null)?.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('returns a container node\'s children', () => {
    const tree = [group('g', [leaf('a')])];
    expect(childrenOf(tree, 'g')?.map((n) => n.id)).toEqual(['a']);
  });

  it('returns undefined for a leaf id (not a container)', () => {
    expect(childrenOf([leaf('a')], 'a')).toBeUndefined();
  });
});

describe('updateNode', () => {
  it('patches a top-level node immutably', () => {
    const tree = [leaf('a'), leaf('b')];
    const next = updateNode(tree, 'a', (n) => ({ ...n, name: 'renamed' }));
    expect(next[0]!.name).toBe('renamed');
    expect(tree[0]!.name).toBe('a'); // original untouched
  });

  it('patches a nested node without disturbing its siblings', () => {
    const tree = [group('g', [leaf('a'), leaf('b')])];
    const next = updateNode(tree, 'b', (n) => ({ ...n, name: 'renamed' }));
    const g = next[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.name)).toEqual(['a', 'renamed']);
  });
});

describe('removeNode', () => {
  it('removes a top-level node', () => {
    const { nodes, removed } = removeNode([leaf('a'), leaf('b')], 'a');
    expect(nodes.map((n) => n.id)).toEqual(['b']);
    expect(removed?.id).toBe('a');
  });

  it('removes a nested node, keeping the container', () => {
    const tree = [group('g', [leaf('a'), leaf('b')])];
    const { nodes, removed } = removeNode(tree, 'a');
    const g = nodes[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b']);
    expect(removed?.id).toBe('a');
  });

  it('removed is undefined when the id is not found', () => {
    const { nodes, removed } = removeNode([leaf('a')], 'ghost');
    expect(removed).toBeUndefined();
    expect(nodes).toHaveLength(1);
  });
});

describe('insertNode', () => {
  it('inserts at the top level at a given index', () => {
    const next = insertNode([leaf('a'), leaf('c')], null, 1, leaf('b'));
    expect(next.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('inserts into a container\'s children', () => {
    const tree = [group('g', [leaf('a')])];
    const next = insertNode(tree, 'g', 1, leaf('b'));
    const g = next[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('clamps an out-of-range index to the end', () => {
    const next = insertNode([leaf('a')], null, 99, leaf('b'));
    expect(next.map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('moveNode', () => {
  it('reorders within the same top-level list', () => {
    const next = moveNode([leaf('a'), leaf('b'), leaf('c')], 'c', null, 0);
    expect(next.map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('moves a node from the top level into a group', () => {
    const tree = [leaf('a'), group('g', [leaf('b')])];
    const next = moveNode(tree, 'a', 'g', 1);
    expect(next.map((n) => n.id)).toEqual(['g']);
    const g = next[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('moves a node out of a group to the top level', () => {
    const tree = [group('g', [leaf('a'), leaf('b')])];
    const next = moveNode(tree, 'a', null, 0);
    expect(next.map((n) => n.id)).toEqual(['a', 'g']);
    const g = next[1] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b']);
  });

  it('is a no-op when the id does not exist', () => {
    const tree = [leaf('a')];
    expect(moveNode(tree, 'ghost', null, 0)).toBe(tree);
  });
});

describe('subtreeContainsId', () => {
  it('is true for the node\'s own id', () => {
    expect(subtreeContainsId(leaf('a'), 'a')).toBe(true);
  });

  it('is true for a descendant', () => {
    expect(subtreeContainsId(group('g', [leaf('a')]), 'a')).toBe(true);
  });

  it('is false for an unrelated id', () => {
    expect(subtreeContainsId(group('g', [leaf('a')]), 'b')).toBe(false);
  });
});

describe('preOrder', () => {
  it('visits a container before its children, then continues to later siblings', () => {
    const tree = [leaf('a'), group('g', [leaf('b'), leaf('c')]), leaf('d')];
    expect(preOrder(tree).map((n) => n.id)).toEqual(['a', 'g', 'b', 'c', 'd']);
  });
});

describe('nodesBefore', () => {
  it('returns every node visited earlier in document order, including an ancestor container', () => {
    const tree = [leaf('a'), group('g', [leaf('b'), leaf('c')])];
    expect(nodesBefore(tree, 'c').map((n) => n.id)).toEqual(['a', 'g', 'b']);
  });

  it('a top-level node sees only earlier top-level nodes', () => {
    const tree = [leaf('a'), leaf('b'), leaf('c')];
    expect(nodesBefore(tree, 'b').map((n) => n.id)).toEqual(['a']);
  });

  it('the first node has no earlier nodes', () => {
    const tree = [leaf('a'), leaf('b')];
    expect(nodesBefore(tree, 'a')).toEqual([]);
  });
});

describe('clearRunIfReferences', () => {
  it('clears a top-level runIf pointing at the removed id', () => {
    const tree = [leaf('b', { runIf: 'a' } as Partial<RecipeNode>)];
    const next = clearRunIfReferences(tree, 'a');
    expect(next[0]!.runIf).toBeUndefined();
  });

  it('clears a nested runIf pointing at the removed id', () => {
    const tree = [group('g', [leaf('b', { runIf: 'a' } as Partial<RecipeNode>)])];
    const next = clearRunIfReferences(tree, 'a');
    const g = next[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(g.children[0]!.runIf).toBeUndefined();
  });

  it('leaves an unrelated runIf untouched', () => {
    const tree = [leaf('a'), leaf('b', { runIf: 'a' } as Partial<RecipeNode>)];
    const next = clearRunIfReferences(tree, 'ghost');
    expect(next[1]!.runIf).toBe('a');
  });
});
