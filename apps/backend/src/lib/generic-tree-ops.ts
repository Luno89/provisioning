export interface GenericContainerNode<TNode> {
  id: string;
  containerType: string;
  children: TNode[];
}

export type GenericTreeNode = { id: string; runIf?: unknown };

export function isGenericContainer<TNode extends GenericTreeNode>(node: TNode): node is TNode & GenericContainerNode<TNode> {
  return 'containerType' in node;
}

export function findNode<TNode extends GenericTreeNode>(nodes: readonly TNode[], id: string): TNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (isGenericContainer(n)) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function parentIdOf<TNode extends GenericTreeNode>(nodes: readonly TNode[], id: string, parent: string | null = null): string | null | undefined {
  for (const n of nodes) {
    if (n.id === id) return parent;
    if (isGenericContainer(n)) {
      const found = parentIdOf(n.children, id, n.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function childrenOf<TNode extends GenericTreeNode>(nodes: readonly TNode[], containerId: string | null): TNode[] | undefined {
  if (containerId === null) return [...nodes];
  const found = findNode(nodes, containerId);
  return found && isGenericContainer(found) ? [...found.children] : undefined;
}

export function updateNode<TNode extends GenericTreeNode>(nodes: TNode[], id: string, patch: (n: TNode) => TNode): TNode[] {
  return nodes.map((n) => {
    if (n.id === id) return patch(n);
    if (isGenericContainer(n)) return { ...n, children: updateNode(n.children, id, patch) };
    return n;
  });
}

export function removeNode<TNode extends GenericTreeNode>(nodes: TNode[], id: string): { nodes: TNode[]; removed?: TNode | undefined } {
  let removed: TNode | undefined;
  const direct = nodes.filter((n) => {
    if (n.id === id) { removed = n; return false; }
    return true;
  });
  if (removed) return { nodes: direct, removed };

  const next: TNode[] = [];
  for (const n of nodes) {
    if (isGenericContainer(n)) {
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

export function insertNode<TNode extends GenericTreeNode>(nodes: TNode[], parentId: string | null, index: number, node: TNode): TNode[] {
  if (parentId === null) {
    const next = [...nodes];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, node);
    return next;
  }
  return nodes.map((n) => {
    if (n.id === parentId && isGenericContainer(n)) {
      const children = [...n.children];
      children.splice(Math.max(0, Math.min(index, children.length)), 0, node);
      return { ...n, children };
    }
    if (isGenericContainer(n)) return { ...n, children: insertNode(n.children, parentId, index, node) };
    return n;
  });
}

export function reorderChildren<TNode extends GenericTreeNode>(nodes: TNode[], parentId: string | null, orderedIds: readonly string[]): TNode[] | undefined {
  const current = childrenOf(nodes, parentId);
  if (!current) return undefined;
  if (current.length !== orderedIds.length || !current.every((n) => orderedIds.includes(n.id))) return undefined;

  const byId = new Map(current.map((n) => [n.id, n]));
  const reordered = orderedIds.map((id) => byId.get(id)!);

  if (parentId === null) return reordered;
  return updateNode(nodes, parentId, (n) => (isGenericContainer(n) ? { ...n, children: reordered } : n));
}

export function clearRunIfReferences<TNode extends GenericTreeNode>(nodes: TNode[], removedId: string): TNode[] {
  return nodes.map((n) => {
    const cleared = n.runIf === removedId ? { ...n, runIf: undefined } : n;
    return isGenericContainer(cleared) ? { ...cleared, children: clearRunIfReferences(cleared.children, removedId) } : cleared;
  });
}

export function preOrderNodes<TNode extends GenericTreeNode>(nodes: readonly TNode[]): TNode[] {
  const out: TNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (isGenericContainer(n)) out.push(...preOrderNodes(n.children));
  }
  return out;
}
