export interface ExtensionSettings {
  ownerId: string;
  disabled: string[];
  updatedAt: string;
}

export interface ExtensionShape {
  id: string;
  title: string;
  requires?: readonly string[] | undefined;
  operations?: readonly { name: string }[] | undefined;
  groups?: readonly { id: string }[] | undefined;
  tools?: readonly { name: string }[] | undefined;
  personas?: readonly { slug: string }[] | undefined;
}

export const ALWAYS_ON: readonly string[] = ['platform'];

export function enabledExtensions<T extends ExtensionShape>(installed: readonly T[], settings: Pick<ExtensionSettings, 'disabled'> | undefined): T[] {
  const off = new Set((settings?.disabled ?? []).filter((id) => !ALWAYS_ON.includes(id)));
  return installed.filter((extension) => !off.has(extension.id));
}

export function switchProblem(installed: readonly ExtensionShape[], disabled: readonly string[], id: string, enabled: boolean): string | null {
  const target = installed.find((extension) => extension.id === id);
  if (!target) return `there is no extension called "${id}"`;
  if (!enabled && ALWAYS_ON.includes(id)) return `${target.title} is the platform itself, so it cannot be switched off`;
  const off = new Set(disabled);
  if (enabled) {
    const missing = (target.requires ?? []).filter((required) => off.has(required));
    if (missing.length > 0) return `${target.title} needs ${missing.join(', ')}, which is switched off — switch that on first`;
    return null;
  }
  const dependents = installed.filter((extension) => !off.has(extension.id) && extension.id !== id && (extension.requires ?? []).includes(id));
  if (dependents.length > 0) return `${dependents.map((extension) => extension.title).join(', ')} needs ${target.title}, so switch that off first`;
  return null;
}

export function withSwitch(settings: ExtensionSettings | undefined, ownerId: string, id: string, enabled: boolean, now: string): ExtensionSettings {
  const disabled = new Set(settings?.disabled ?? []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  return { ownerId, disabled: [...disabled].sort(), updatedAt: now };
}

export interface HiddenVocabulary {
  extensions: Set<string>;
  operations: Set<string>;
  groups: Set<string>;
  tools: Set<string>;
  agents: Set<string>;
}

export function hiddenBy(installed: readonly ExtensionShape[], settings: Pick<ExtensionSettings, 'disabled'> | undefined): HiddenVocabulary {
  const enabled = new Set(enabledExtensions(installed, settings).map((extension) => extension.id));
  const off = installed.filter((extension) => !enabled.has(extension.id));
  return {
    extensions: new Set(off.map((extension) => extension.id)),
    operations: new Set(off.flatMap((extension) => (extension.operations ?? []).map((operation) => operation.name))),
    groups: new Set(off.flatMap((extension) => (extension.groups ?? []).map((group) => group.id))),
    tools: new Set(off.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name))),
    agents: new Set(off.flatMap((extension) => (extension.personas ?? []).map((persona) => persona.slug))),
  };
}

export function extensionOf(installed: readonly ExtensionShape[], kind: 'operation' | 'group', name: string): ExtensionShape | undefined {
  return installed.find((extension) => (kind === 'operation'
    ? (extension.operations ?? []).some((operation) => operation.name === name)
    : (extension.groups ?? []).some((group) => group.id === name)));
}

interface PlacedLike { id: string; kind: string; group?: string | undefined; settings?: Readonly<Record<string, unknown>> | undefined }

export function switchedOffProblems(
  procedure: { nodes: readonly PlacedLike[]; groups?: readonly { id: string; nodes: readonly PlacedLike[] }[] | undefined },
  hidden: HiddenVocabulary,
): { severity: 'error'; message: string; node: string }[] {
  const problems: { severity: 'error'; message: string; node: string }[] = [];
  const own = new Set((procedure.groups ?? []).map((group) => group.id));
  const look = (nodes: readonly PlacedLike[]) => {
    for (const node of nodes) {
      const operation = typeof node.settings?.operation === 'string' ? node.settings.operation : undefined;
      const agent = typeof node.settings?.agent === 'string' ? node.settings.agent : undefined;
      if (node.kind === 'host-op' && operation && hidden.operations.has(operation)) {
        problems.push({ severity: 'error', node: node.id, message: `uses ${operation}, from the ${operation.split('.')[0]} extension, which is switched off for you` });
      }
      if (node.kind === 'group' && node.group && !own.has(node.group) && hidden.groups.has(node.group)) {
        problems.push({ severity: 'error', node: node.id, message: `uses the group ${node.group}, from an extension that is switched off for you` });
      }
      if ((node.kind === 'delegate' || node.kind === 'fan-out') && agent && hidden.agents.has(agent)) {
        problems.push({ severity: 'error', node: node.id, message: `hands work to ${agent}, an agent of an extension that is switched off for you` });
      }
    }
  };
  look(procedure.nodes);
  for (const group of procedure.groups ?? []) look(group.nodes);
  return problems;
}

export class SwitchedOffError extends Error {
  constructor(procedure: string, problems: readonly { node: string; message: string }[]) {
    super(`${procedure} cannot run: ${problems.map((problem) => `"${problem.node}" ${problem.message}`).join('; ')}.`);
    this.name = 'SwitchedOffError';
  }
}
