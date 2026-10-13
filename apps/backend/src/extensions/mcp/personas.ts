import type { PersonaRecord } from '@koala/agent-engine';

export const MCP_CAPTURE_AGENT = 'mcp-capture';

export const MCP_PERSONAS: PersonaRecord[] = [
  {
    slug: MCP_CAPTURE_AGENT,
    name: 'MCP capture',
    description: 'Asks an MCP server what it says about itself and which tools it serves, and keeps the answer on its record',
    version: '1',
    guidance: 'Started when a server is added to the catalogue, when how it runs changes, or when the person asks to capture it again. It runs no model of its own: its procedure builds and starts the server, or connects to it, and records what it said.',
    returns: 'What was recorded: how many tools it serves, or why it could not be captured.',
    failures: [
      { when: 'the server\'s image does not build', says: 'why, from the build\'s log' },
      { when: 'the server does not start or answer', says: 'why, with the end of its log' },
    ],
    procedure: 'capture-mcp-server',
    maxEffect: 'write',
    environment: {},
    interface: {
      inputs: {
        type: 'object',
        properties: { serverId: { type: 'string', description: 'The server in the catalogue to capture.' } },
        required: ['serverId'],
      },
      outputs: ['result'],
    },
    prompt: 'You are the structure of a server capture, not a thinker in it. The procedure decides every step.',
  },
];
