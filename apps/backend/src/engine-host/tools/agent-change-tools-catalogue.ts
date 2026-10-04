import type { ToolDefinition } from '@koala/agent-engine';

export const AGENT_CHANGE_TOOLS: ToolDefinition[] = [
  {
    name: 'propose_prompt_change',
    summary: 'Propose a change to an agent\'s prompt; the bench compares its scenarios before and after, and the person decides',
    guidance: 'Use this only when a practice is not enough — when the agent\'s prompt itself says something wrong or misses something it always needs. Make the smallest change that fixes what was observed: give the whole new prompt, keeping everything that was not part of the problem word for word. It never goes live on its own.',
    binding: 'platform',
    effect: 'propose',
    idempotent: false,
    openWorld: false,
    returns: 'that the change waits for the bench and then the person, or why it was not proposed',
    failures: [
      { when: 'the agent does not exist', says: 'so' },
      { when: 'the new prompt is the same as the current one, or a change for this agent is already waiting', says: 'so, and proposes nothing' },
    ],
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent whose prompt to change.' },
        prompt: { type: 'string', description: 'The whole new prompt.' },
        why: { type: 'string', description: 'What was observed that this fixes, naming runs when there are some.' },
      },
      required: ['agent', 'prompt', 'why'],
    },
  },
  {
    name: 'request_procedure_change',
    summary: 'Ask for a change to a procedure, in plain words, for the person to hand to the agent builder',
    guidance: 'Use this when what went wrong is in the steps an agent runs — a procedure that ends ok when it should fail, a step it skips — rather than in what the agent was told. Say what should change, not how to rewrite the graph.',
    binding: 'platform',
    effect: 'propose',
    idempotent: false,
    openWorld: false,
    returns: 'that the request waits for the person, or why it was not filed',
    failures: [
      { when: 'the agent or the procedure does not exist', says: 'so' },
    ],
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent whose procedure it is.' },
        procedure: { type: 'string', description: 'The procedure to change; defaults to the one the agent runs.' },
        request: { type: 'string', description: 'What should change, in plain words.' },
        why: { type: 'string', description: 'What happened that shows it, naming runs when there are some.' },
      },
      required: ['agent', 'request', 'why'],
    },
  },
];
