import type { ToolDefinition } from '@koala/agent-engine';

export const RUN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_run',
    summary: 'Read what another run did, node by node: the model\'s turns, the tool calls and what they gave back, where it stopped and why',
    guidance: 'Use this to see what was actually attempted rather than what a claim or summary says about it — for example the run ids a failed task lists. Without node it gives the whole run, one line per node; give node (the name the overview shows, with #sequence for one execution of it) to read that step in full.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'the run\'s nodes in order, each with how it exited, any error and what it produced — or one node\'s inputs and outputs in full',
    failures: [
      { when: 'the run is not one of the person\'s, or recorded nothing', says: 'that there is no such run' },
      { when: 'the node is not in the run', says: 'which nodes it has' },
    ],
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The run to read.' },
        node: { type: 'string', description: 'One node to read in full, as the overview names it: "turn" for every execution of it, or "turn#12" for one.' },
      },
      required: ['runId'],
    },
  },
];
