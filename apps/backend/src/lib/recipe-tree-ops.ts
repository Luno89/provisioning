import type { RecipeNode } from './tree-types.js';
import {
  findNode, parentIdOf, childrenOf, updateNode, removeNode, insertNode, reorderChildren,
  clearRunIfReferences, preOrderNodes,
} from './generic-tree-ops.js';

export function findRecipeNode(nodes: readonly RecipeNode[], id: string): RecipeNode | undefined {
  return findNode(nodes, id);
}

export function parentIdOfRecipeNode(nodes: readonly RecipeNode[], id: string, parent: string | null = null): string | null | undefined {
  return parentIdOf(nodes, id, parent);
}

export function childrenOfRecipeNode(nodes: readonly RecipeNode[], containerId: string | null): RecipeNode[] | undefined {
  return childrenOf(nodes, containerId);
}

export function updateRecipeNode(nodes: RecipeNode[], id: string, patch: (n: RecipeNode) => RecipeNode): RecipeNode[] {
  return updateNode(nodes, id, patch);
}

export function removeRecipeNode(nodes: RecipeNode[], id: string): { nodes: RecipeNode[]; removed?: RecipeNode | undefined } {
  return removeNode(nodes, id);
}

export function insertRecipeNode(nodes: RecipeNode[], parentId: string | null, index: number, node: RecipeNode): RecipeNode[] {
  return insertNode(nodes, parentId, index, node);
}

export function reorderRecipeChildren(nodes: RecipeNode[], parentId: string | null, orderedIds: readonly string[]): RecipeNode[] | undefined {
  return reorderChildren(nodes, parentId, orderedIds);
}

export function clearRecipeRunIfReferences(nodes: RecipeNode[], removedId: string): RecipeNode[] {
  return clearRunIfReferences(nodes, removedId);
}

export function preOrderRecipeNodes(nodes: readonly RecipeNode[]): RecipeNode[] {
  return preOrderNodes(nodes);
}
