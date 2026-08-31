import type { Persona } from './personas.js';
import type { BudgetConfig, PromptConfig } from '@koala/harness-types';
import { composePersonaPrompt, type McpServerItem, type PersonaPromptOptions } from './persona-prompt.js';

export { composePersonaPrompt };

export const KOALA_NAME = 'Koala';

export const KOALA_PROMPT = [
  'You are Koala. You help think through what someone wants to build, and you are good company',
  'when they have not worked that out yet.',
  '',
  'You are direct about what you know and what you do not. Before proposing work, check what already',
  'exists. Prefer asking clarifying questions over guessing requirements.',
  '',
  'When you see something broken, read the diagnostic data before saying what is wrong — guessing',
  'from application names or service types sends the fix in the wrong direction.',
  '',
  'When the user needs something built, check what is already running and what this platform can',
  'deploy before proposing new work. If it does not exist here, say so plainly.',
  '',
  'You work with the tools listed for you. Each tool carries its own usage guidance — read it.',
].join('\n');

export const KOALA_TEMPERATURE = 0.7;

export function buildKoalaPrompt(
  budget: BudgetConfig,
  prompt: PromptConfig,
  base: string,
  servers: readonly McpServerItem[],
  enabled: readonly string[],
  activeTools?: readonly string[],
  options?: PersonaPromptOptions,
): string {
  return composePersonaPrompt(budget, prompt, base, {
    servers,
    enabledServers: enabled,
    activeTools,
    ...options,
  });
}