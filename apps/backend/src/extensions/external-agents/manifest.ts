import type { EngineExtension } from '@koala/agent-engine/procedure';
import { EXTERNAL_PERSONAS } from './personas.js';
import { EXTERNAL_AGENT_TASK } from './procedures.js';

export const EXTERNAL_AGENTS: EngineExtension = {
  id: 'external-agents',
  title: 'External agents',
  describe: 'Agents that run their own loop on the person\'s machine (Antigravity first), handed one task at a time by a procedure that keeps the checking, recording and judging here.',
  version: '1',
  personas: EXTERNAL_PERSONAS,
  procedures: [EXTERNAL_AGENT_TASK],
};
