import { describe, it, expect } from 'vitest';
import {
  findNode, parentIdOf, childrenOf, insertNode, removeNode, reorderChildren, clearRunIfReferences,
  preOrderNodes, isGenericContainer,
} from './generic-tree-ops.js';

interface StageLeaf { id: string; kind: 'stage'; runIf?: string | undefined }
interface StageGroup { id: string; containerType: 'group'; children: StageNode[]; runIf?: string | undefined }
type StageNode = StageLeaf | StageGroup;

const leaf = (id: string, runIf?: string): StageNode => ({ id, kind: 'stage', ...(runIf ? { runIf } : {}) });
const group = (id: string, children: StageNode[]): StageNode => ({ id, containerType: 'group', children });

describe('generic-tree-ops against a non-RecipeNode shape', () => {
  it('finds nested nodes and reports container-ness correctly', () => {
    const tree = [leaf('a'), group('g', [leaf('b')])];
    expect(findNode(tree, 'b')?.id).toBe('b');
    expect(isGenericContainer(tree[1]!)).toBe(true);
    expect(isGenericContainer(tree[0]!)).toBe(false);
  });

  it('resolves parent/children across a level', () => {
    const tree = [leaf('a'), group('g', [leaf('b')])];
    expect(parentIdOf(tree, 'b')).toBe('g');
    expect(childrenOf(tree, 'g')?.map((n) => n.id)).toEqual(['b']);
  });

  it('inserts, removes, reorders, and clears runIf references', () => {
    let tree = [leaf('a'), leaf('b')];
    tree = insertNode(tree, null, 1, leaf('c'));
    expect(tree.map((n) => n.id)).toEqual(['a', 'c', 'b']);

    const { nodes, removed } = removeNode(tree, 'c');
    expect(removed?.id).toBe('c');
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b']);

    expect(reorderChildren(nodes, null, ['b', 'a'])?.map((n) => n.id)).toEqual(['b', 'a']);

    const withRunIf = [leaf('a'), leaf('b', 'a')];
    expect(clearRunIfReferences(withRunIf, 'a')[1]!.runIf).toBeUndefined();
  });

  it('walks depth-first, container before children', () => {
    const tree = [leaf('a'), group('g', [leaf('b'), leaf('c')])];
    expect(preOrderNodes(tree).map((n) => n.id)).toEqual(['a', 'g', 'b', 'c']);
  });
});
