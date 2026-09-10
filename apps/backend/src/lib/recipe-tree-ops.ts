import { isContainerNode, type RecipeNode } from './tree-types.js';

export function findRecipeNode(nodes: readonly RecipeNode[], id: string): RecipeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (isContainerNode(n)) {
      const found = findRecipeNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function parentIdOfRecipeNode(nodes: readonly RecipeNode[], id: string, parent: string | null = null): string | null | undefined {
  for (const n of nodes) {
    if (n.id === id) return parent;
    if (isContainerNode(n)) {
      const found = parentIdOfRecipeNode(n.children, id, n.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function childrenOfRecipeNode(nodes: readonly RecipeNode[], containerId: string | null): RecipeNode[] | undefined {
  if (containerId === null) return [...nodes];
  const found = findRecipeNode(nodes, containerId);
  return found && isContainerNode(found) ? [...found.children] : undefined;
}

export function updateRecipeNode(nodes: RecipeNode[], id: string, patch: (n: RecipeNode) => RecipeNode): RecipeNode[] {
  return nodes.map((n) => {
    if (n.id === id) return patch(n);
    if (isContainerNode(n)) return { ...n, children: updateRecipeNode(n.children, id, patch) };
    return n;
  });
}

export function removeRecipeNode(nodes: RecipeNode[], id: string): { nodes: RecipeNode[]; removed?: RecipeNode | undefined } {
  let removed: RecipeNode | undefined;
  const direct = nodes.filter((n) => {
    if (n.id === id) { removed = n; return false; }
    return true;
  });
  if (removed) return { nodes: direct, removed };

  const next: RecipeNode[] = [];
  for (const n of nodes) {
    if (isContainerNode(n)) {
      const res = removeRecipeNode(n.children, id);
      if (res.removed) {
        removed = res.removed;
        next.push({ ...n, children: res.nodes });
        continue;
      }
    }
    next.push(n);
  }
  return { nodes: next, removed };
}

export function insertRecipeNode(nodes: RecipeNode[], parentId: string | null, index: number, node: RecipeNode): RecipeNode[] {
  if (parentId === null) {
    const next = [...nodes];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, node);
    return next;
  }
  return nodes.map((n) => {
    if (n.id === parentId && isContainerNode(n)) {
      const children = [...n.children];
      children.splice(Math.max(0, Math.min(index, children.length)), 0, node);
      return { ...n, children };
    }
    if (isContainerNode(n)) return { ...n, children: insertRecipeNode(n.children, parentId, index, node) };
    return n;
  });
}

export function reorderRecipeChildren(nodes: RecipeNode[], parentId: string | null, orderedIds: readonly string[]): RecipeNode[] | undefined {
  const current = childrenOfRecipeNode(nodes, parentId);
  if (!current) return undefined;
  if (current.length !== orderedIds.length || !current.every((n) => orderedIds.includes(n.id))) return undefined;

  const byId = new Map(current.map((n) => [n.id, n]));
  const reordered = orderedIds.map((id) => byId.get(id)!);

  if (parentId === null) return reordered;
  return updateRecipeNode(nodes, parentId, (n) => (isContainerNode(n) ? { ...n, children: reordered } : n));
}

export function clearRecipeRunIfReferences(nodes: RecipeNode[], removedId: string): RecipeNode[] {
  return nodes.map((n) => {
    const cleared = n.runIf === removedId ? { ...n, runIf: undefined } : n;
    return isContainerNode(cleared) ? { ...cleared, children: clearRecipeRunIfReferences(cleared.children, removedId) } : cleared;
  });
}

export function preOrderRecipeNodes(nodes: readonly RecipeNode[]): RecipeNode[] {
  const out: RecipeNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (isContainerNode(n)) out.push(...preOrderRecipeNodes(n.children));
  }
  return out;
}
