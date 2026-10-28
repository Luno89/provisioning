import type { ActingFor } from '@koala/agent-engine/procedure';

export const memberAsking = (asker: Pick<ActingFor, 'email' | 'role'>): string =>
  `${asker.email}, a ${asker.role} on this shared project and not its owner,`;

const HELD_BACK_FROM_OTHERS = new Set(['forget_memory', 'propose_practice', 'propose_prompt_change', 'propose_scenario', 'propose_tool_note', 'request_procedure_change']);

export function keptToProblem(tool: string, args: Readonly<Record<string, unknown>>): string | undefined {
  const why = 'this conversation has messages from people other than the owner of this instance, so only what belongs to its project is remembered from it';
  if (HELD_BACK_FROM_OTHERS.has(tool)) return `${tool} is not used here: ${why}.`;
  if (tool !== 'save_memory') return undefined;
  if (args.scope === 'global') return `save_memory keeps this to the project, never global: ${why}.`;
  if (args.replaces !== undefined && args.replaces !== '') return `save_memory replaces nothing here: ${why}.`;
  return undefined;
}

export const heldBackFromOthers = (tool: string): boolean => HELD_BACK_FROM_OTHERS.has(tool);
