import type { Persona } from '../agent/agent.js';
import type { ToolDefinition } from '../tools/catalogue.js';
import type { NodeCatalogue } from './definition.js';
import type { GroupDefinition, Procedure } from './schema.js';
import type { HostOperation } from './host-operations.js';
import { builtInCatalogue } from './nodes/index.js';
import { BUILT_IN_GROUPS } from './seeds/groups.js';
import { checkProcedure } from './validate.js';

export interface EngineExtension {
  id: string;
  title: string;
  describe: string;
  version: string;
  requires?: readonly string[] | undefined;
  operations?: readonly HostOperation[] | undefined;
  groups?: readonly GroupDefinition[] | undefined;
  tools?: readonly ToolDefinition[] | undefined;
  personas?: readonly Persona[] | undefined;
  procedures?: readonly Procedure[] | undefined;
}

export interface ExtensionCheckOptions {
  authored?: ReadonlySet<string> | undefined;
  tools?: readonly string[] | undefined;
  procedures?: readonly Procedure[] | undefined;
  personas?: readonly string[] | undefined;
}

const EXTENSION_ID = /^[a-z][a-z0-9-]*$/;

export const operationsOf = (extensions: readonly EngineExtension[]): HostOperation[] =>
  extensions.flatMap((extension) => extension.operations ?? []);

export const catalogueFor = (extensions: readonly EngineExtension[]): NodeCatalogue => builtInCatalogue(operationsOf(extensions));

export const groupsFor = (extensions: readonly EngineExtension[]): GroupDefinition[] =>
  [...BUILT_IN_GROUPS, ...extensions.flatMap((extension) => extension.groups ?? [])];

function repeated(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const name of names) (seen.has(name) ? twice : seen).add(name);
  return [...twice];
}

export function extensionProblems(extensions: readonly EngineExtension[], options: ExtensionCheckOptions = {}): string[] {
  const problems: string[] = [];
  const ids = new Set(extensions.map((extension) => extension.id));

  for (const id of repeated(extensions.map((extension) => extension.id))) problems.push(`extension "${id}" is installed twice`);
  for (const name of repeated(operationsOf(extensions).map((operation) => operation.name))) problems.push(`operation "${name}" is offered twice`);
  for (const id of repeated(groupsFor(extensions).map((group) => group.id))) problems.push(`group "${id}" is offered twice`);
  for (const name of repeated(extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)))) problems.push(`tool "${name}" is offered twice`);
  for (const slug of repeated(extensions.flatMap((extension) => (extension.personas ?? []).map((persona) => persona.slug)))) problems.push(`agent "${slug}" is offered twice`);
  for (const id of repeated([...(options.procedures ?? []), ...extensions.flatMap((extension) => extension.procedures ?? [])].map((procedure) => procedure.id))) {
    problems.push(`procedure "${id}" is offered twice`);
  }

  for (const extension of extensions) {
    const say = (message: string) => problems.push(`extension "${extension.id}" ${message}`);
    if (!EXTENSION_ID.test(extension.id)) say('has an id that is not lower-case words joined by dashes');
    for (const required of extension.requires ?? []) if (!ids.has(required)) say(`needs "${required}", which is not installed`);
    if (options.authored?.has(extension.id) && (extension.operations ?? []).length > 0) {
      say('declares operations, which only the platform can implement — an authored operation is a group');
    }
    for (const operation of extension.operations ?? []) {
      if (!operation.name.startsWith(`${extension.id}.`)) say(`offers operation "${operation.name}", which is not named under "${extension.id}."`);
    }
    for (const group of extension.groups ?? []) {
      if (!group.id.startsWith(`${extension.id}.`)) say(`offers group "${group.id}", which is not named under "${extension.id}."`);
    }
  }

  const catalogue = catalogueFor(extensions);
  const groups = groupsFor(extensions);
  const procedures = [...(options.procedures ?? []), ...extensions.flatMap((extension) => extension.procedures ?? [])];
  const procedureIds = new Set(procedures.map((procedure) => procedure.id));
  const agents = new Set([...(options.personas ?? []), ...extensions.flatMap((extension) => (extension.personas ?? []).map((persona) => persona.slug))]);
  const tools = new Set([...(options.tools ?? []), ...extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name))]);

  for (const extension of extensions) {
    const say = (message: string) => problems.push(`extension "${extension.id}" ${message}`);
    for (const procedure of extension.procedures ?? []) {
      const errors = checkProcedure(procedure, { catalogue, groups, known: { agents, tools } }).filter((problem) => problem.severity === 'error');
      for (const error of errors) say(`seeds procedure "${procedure.id}", which does not check: ${error.message}`);
    }
    for (const persona of extension.personas ?? []) {
      if (!procedureIds.has(persona.procedure)) say(`seeds agent "${persona.slug}" on procedure "${persona.procedure}", which nothing offers`);
      for (const tool of persona.tools) if (!tools.has(tool)) say(`seeds agent "${persona.slug}" with tool "${tool}", which nothing offers`);
      for (const agent of persona.agents ?? []) if (!agents.has(agent)) say(`seeds agent "${persona.slug}" delegating to "${agent}", which nothing offers`);
    }
  }

  return problems;
}
