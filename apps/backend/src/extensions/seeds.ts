import { ALL_SEEDED_AGENTS, BUILDER_TOOLS, type Persona, type ToolDefinition } from '@koala/agent-engine';
import { BUILT_IN_PROCEDURES, type Procedure } from '@koala/agent-engine/procedure';
import { INSTALLED_EXTENSIONS } from './installed.js';

export const seededPersonas = (): Persona[] => [...ALL_SEEDED_AGENTS(), ...INSTALLED_EXTENSIONS.flatMap((extension) => extension.personas ?? [])];

export const seededProcedures = (): Procedure[] => [...BUILT_IN_PROCEDURES, ...INSTALLED_EXTENSIONS.flatMap((extension) => extension.procedures ?? [])];

export const extensionTools = (): ToolDefinition[] => INSTALLED_EXTENSIONS.flatMap((extension) => extension.tools ?? []);

export const engineOwn = () => ({
  personas: ALL_SEEDED_AGENTS().map((persona) => persona.slug),
  tools: BUILDER_TOOLS.map((tool) => tool.name),
  procedures: [...BUILT_IN_PROCEDURES],
});
