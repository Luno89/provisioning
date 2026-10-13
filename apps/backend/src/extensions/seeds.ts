import { ALL_SEEDED_AGENTS, BUILDER_TOOLS, SEEDED_GRANTS, grantsFrom, withGrants, type Persona, type PersonaRecord, type ToolDefinition, type ToolGrant } from '@koala/agent-engine';
import { BUILT_IN_PROCEDURES, shippedGrantsOf, type Procedure } from '@koala/agent-engine/procedure';
import { INSTALLED_EXTENSIONS } from './installed.js';

export const seededPersonas = (): PersonaRecord[] => [...ALL_SEEDED_AGENTS(), ...INSTALLED_EXTENSIONS.flatMap((extension) => extension.personas ?? [])];

export const seededGrants = (): ToolGrant[] => [...grantsFrom(SEEDED_GRANTS), ...shippedGrantsOf(INSTALLED_EXTENSIONS)];

export const seededAgents = (): Persona[] => withGrants(seededPersonas(), seededGrants(), []);

export const seededProcedures = (): Procedure[] => [...BUILT_IN_PROCEDURES, ...INSTALLED_EXTENSIONS.flatMap((extension) => extension.procedures ?? [])];

export const extensionTools = (): ToolDefinition[] => INSTALLED_EXTENSIONS.flatMap((extension) => extension.tools ?? []);

export const engineOwn = () => ({
  personas: ALL_SEEDED_AGENTS().map((persona) => persona.slug),
  tools: BUILDER_TOOLS.map((tool) => tool.name),
  procedures: [...BUILT_IN_PROCEDURES],
});
