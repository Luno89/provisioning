import {
  PROCEDURE_SCHEMA,
  checkProcedure,
  type GroupDefinition,
  type NodeCatalogue,
  type PlacedNode,
  type Procedure,
  type ProcedureProblem,
} from '@koala/agent-engine/procedure';

export interface PublishedVersion {
  version: number;
  group: GroupDefinition;
  savedAt: string;
}

export interface AuthoredOperation {
  name: string;
  versions: PublishedVersion[];
}

export interface AuthoredExtension {
  ownerId: string;
  id: string;
  title: string;
  describe: string;
  operations: AuthoredOperation[];
  tools: string[];
  personas: string[];
  procedures: string[];
  createdAt: string;
  updatedAt: string;
}

const SLUG = /^[a-z][a-z0-9-]*$/;
const PUBLISHED = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)@(\d+)$/;

export const publishedId = (extension: string, name: string, version: number): string => `${extension}.${name}@${version}`;

export function parsePublishedId(id: string): { extension: string; name: string; version: number } | undefined {
  const match = PUBLISHED.exec(id);
  return match ? { extension: match[1]!, name: match[2]!, version: Number(match[3]) } : undefined;
}

export const latestOf = (operation: AuthoredOperation): PublishedVersion => operation.versions[operation.versions.length - 1]!;

export function authoredGroups(extension: Pick<AuthoredExtension, 'operations'>): GroupDefinition[] {
  return extension.operations.flatMap((operation) => operation.versions.map((version) => version.group));
}

export function authoredVocabulary(extension: AuthoredExtension) {
  return {
    id: extension.id,
    title: extension.title,
    describe: extension.describe,
    version: String(Math.max(0, ...extension.operations.map((operation) => latestOf(operation).version))),
    groups: authoredGroups(extension),
    latest: extension.operations.map((operation) => latestOf(operation).group.id),
    tools: extension.tools.map((name) => ({ name })),
    personas: extension.personas.map((slug) => ({ slug })),
    procedures: extension.procedures,
  };
}

export function extensionProblem(candidate: Pick<AuthoredExtension, 'id' | 'title'>, taken: ReadonlySet<string>): string | null {
  if (!SLUG.test(candidate.id)) return 'an extension id is lower-case words joined by dashes';
  if (taken.has(candidate.id)) return `"${candidate.id}" is already an extension's id`;
  if (!candidate.title.trim()) return 'an extension needs a title';
  return null;
}

export function groupProblems(group: GroupDefinition, options: { catalogue: NodeCatalogue; groups: readonly GroupDefinition[] }): ProcedureProblem[] {
  const holder: Procedure = {
    schema: PROCEDURE_SCHEMA,
    id: 'publish-check',
    version: '1',
    name: 'publish check',
    describe: 'holds a group being published',
    budget: {},
    start: 'end',
    nodes: [{ id: 'end', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 0, y: 0 } }],
    wires: [],
    flow: [],
    groups: [group],
  };
  return checkProcedure(holder, options).filter((problem) => problem.severity === 'error' && problem.group === group.id);
}

const nodesOf = (procedure: Pick<Procedure, 'nodes' | 'groups'>): PlacedNode[] => [...procedure.nodes, ...procedure.groups.flatMap((group) => group.nodes)];

export function usesOperation(procedure: Pick<Procedure, 'nodes' | 'groups'>, extension: string, name: string): boolean {
  return nodesOf(procedure).some((node) => {
    const parsed = node.kind === 'group' && node.group ? parsePublishedId(node.group) : undefined;
    return parsed?.extension === extension && parsed.name === name;
  });
}

export function onVersion<T extends Pick<Procedure, 'nodes' | 'groups'>>(procedure: T, extension: string, name: string, version: number): T {
  const bump = (node: PlacedNode): PlacedNode => {
    const parsed = node.kind === 'group' && node.group ? parsePublishedId(node.group) : undefined;
    return parsed?.extension === extension && parsed.name === name ? { ...node, group: publishedId(extension, name, version) } : node;
  };
  return {
    ...procedure,
    nodes: procedure.nodes.map(bump),
    groups: procedure.groups.map((group) => ({ ...group, nodes: group.nodes.map(bump) })),
  };
}

export function referencedPublished(procedure: Pick<Procedure, 'nodes' | 'groups'>): string[] {
  return [...new Set(nodesOf(procedure).filter((node) => node.kind === 'group' && node.group && parsePublishedId(node.group)).map((node) => node.group!))];
}
