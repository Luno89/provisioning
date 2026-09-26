import type { ToolDefinition } from '@koala/agent-engine';

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'enable_mcp_server',
    summary: 'Ask the person to switch one of their MCP servers on for this conversation, so its tools become available',
    guidance: 'Use this when the conversation needs something one of the person\'s own services can do and its tools are not offered to you yet. The person approves it on a card; the tools arrive on the next turn.',
    binding: 'platform',
    effect: 'propose',
    idempotent: true,
    openWorld: false,
    status: 'draft',
    returns: 'that the person was asked, that it was already asked, or that the server is already on',
    failures: [
      { when: 'no server by that name is running', says: 'the names of the servers that are' },
      { when: 'no reason is given', says: 'to say why the conversation needs it' },
      { when: 'the run is not part of a conversation', says: 'that servers are switched on per conversation' },
    ],
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'The server\'s name, as the person\'s list of services shows it.' },
        why: { type: 'string', description: 'What this conversation needs it for, shown to the person on the card.' },
      },
      required: ['server', 'why'],
    },
  },
];
