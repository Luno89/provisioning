import { isContainerNode, type RecipeNode } from '../shared.js';

export function findNode(nodes: readonly RecipeNode[], id: string): RecipeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (isContainerNode(n)) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function parentIdOf(nodes: readonly RecipeNode[], id: string, parent: string | null = null): string | null | undefined {
  for (const n of nodes) {
    if (n.id === id) return parent;
    if (isContainerNode(n)) {
      const found = parentIdOf(n.children, id, n.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function childrenOf(nodes: readonly RecipeNode[], containerId: string | null): RecipeNode[] | undefined {
  if (containerId === null) return [...nodes];
  const found = findNode(nodes, containerId);
  return found && isContainerNode(found) ? [...found.children] : undefined;
}

export function updateNode(nodes: RecipeNode[], id: string, patch: (n: RecipeNode) => RecipeNode): RecipeNode[] {
  return nodes.map((n) => {
    if (n.id === id) return patch(n);
    if (isContainerNode(n)) return { ...n, children: updateNode(n.children, id, patch) };
    return n;
  });
}

export function removeNode(nodes: RecipeNode[], id: string): { nodes: RecipeNode[]; removed?: RecipeNode | undefined } {
  let removed: RecipeNode | undefined;
  const direct = nodes.filter((n) => {
    if (n.id === id) { removed = n; return false; }
    return true;
  });
  if (removed) return { nodes: direct, removed };

  const next: RecipeNode[] = [];
  for (const n of nodes) {
    if (isContainerNode(n)) {
      const res = removeNode(n.children, id);
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

export function insertNode(nodes: RecipeNode[], parentId: string | null, index: number, node: RecipeNode): RecipeNode[] {
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
    if (isContainerNode(n)) return { ...n, children: insertNode(n.children, parentId, index, node) };
    return n;
  });
}

export function moveNode(nodes: RecipeNode[], id: string, toParentId: string | null, toIndex: number): RecipeNode[] {
  const { nodes: without, removed } = removeNode(nodes, id);
  if (!removed) return nodes;
  return insertNode(without, toParentId, toIndex, removed);
}

export function subtreeContainsId(node: RecipeNode, id: string): boolean {
  if (node.id === id) return true;
  return isContainerNode(node) && node.children.some((c) => subtreeContainsId(c, id));
}

export function preOrder(nodes: readonly RecipeNode[]): RecipeNode[] {
  const out: RecipeNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (isContainerNode(n)) out.push(...preOrder(n.children));
  }
  return out;
}

export function nodesBefore(nodes: readonly RecipeNode[], id: string): RecipeNode[] {
  const order = preOrder(nodes);
  const idx = order.findIndex((n) => n.id === id);
  return idx === -1 ? order : order.slice(0, idx);
}

export function clearRunIfReferences(nodes: RecipeNode[], removedId: string): RecipeNode[] {
  return nodes.map((n) => {
    const cleared = n.runIf === removedId ? { ...n, runIf: undefined } : n;
    return isContainerNode(cleared) ? { ...cleared, children: clearRunIfReferences(cleared.children, removedId) } : cleared;
  });
}
