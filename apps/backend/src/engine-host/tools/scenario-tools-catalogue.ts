import type { ToolDefinition } from '@koala/agent-engine';

export const SCENARIO_TOOLS: ToolDefinition[] = [
  {
    name: 'propose_scenario',
    summary: 'Propose a test that would catch a mistake an agent made, for the person to accept into their bench',
    guidance: 'Use this when what happened shows an agent doing something wrong that a test could catch next time — a failure, a judge\'s diagnosis, or the person correcting it. Write the message that reproduces the situation and what a correct run must do, in terms of tools called or not called and how it ends. Nothing runs until the person accepts it.',
    binding: 'platform',
    effect: 'propose',
    idempotent: false,
    openWorld: false,
    returns: 'that the proposal is waiting for the person, or why it was not proposed',
    failures: [
      { when: 'the agent, a tool it names, or the scenario is not valid', says: 'exactly what is wrong, so it can be fixed and proposed again' },
      { when: 'a scenario or open proposal with that name already exists for the agent', says: 'so, and proposes nothing' },
    ],
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent the test is for.' },
        name: { type: 'string', description: 'A short name for what it checks.' },
        checks: { type: 'string', description: 'What a correct run does, in a sentence.' },
        message: { type: 'string', description: 'What the agent is asked, so the situation happens again.' },
        outcome: { type: 'string', enum: ['ok', 'failed', 'refused'], description: 'How a correct run ends, when that matters.' },
        toolsCalled: { type: 'array', items: { type: 'string' }, description: 'Tools a correct run calls.' },
        toolsNotCalled: { type: 'array', items: { type: 'string' }, description: 'Tools a correct run never calls.' },
        toolsInOrder: { type: 'array', items: { type: 'string' }, description: 'Tools a correct run calls in this order.' },
        why: { type: 'string', description: 'What happened that this would have caught, naming the run when there is one.' },
      },
      required: ['agent', 'name', 'checks', 'message', 'why'],
    },
  },
];
