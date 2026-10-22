import { groupLibrary, type GroupDefinition, type Procedure } from '@koala/agent-engine/procedure';

export function usesNode(procedure: Pick<Procedure, 'nodes' | 'groups'>, kind: string, shared: readonly GroupDefinition[] = []): boolean {
  const library = groupLibrary(procedure, shared);
  const seen = new Set<string>();
  const within = (nodes: Procedure['nodes']): boolean => nodes.some((node) => {
    if (node.kind === kind) return true;
    if (!node.group || seen.has(node.group)) return false;
    seen.add(node.group);
    const group = library.get(node.group);
    return group ? within(group.nodes) : false;
  });
  return within(procedure.nodes);
}
