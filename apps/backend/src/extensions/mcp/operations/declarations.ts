import type { HostOperation } from '@koala/agent-engine/procedure';

const NONE = { type: 'object', properties: {} } as const;
const SERVER = { name: 'server', type: 'json', describe: 'The server, as Open Server hands it on.', required: true } as const;

export const MCP_OPERATIONS: readonly HostOperation[] = [
  {
    name: 'mcp.open',
    title: 'Open Server',
    group: 'MCP servers',
    describe: 'Reads the server from the catalogue and says where it runs.',
    inputs: [{ name: 'serverId', type: 'text', describe: 'Which server. Nothing wired means the serverId the run was started with.' }],
    outputs: [
      { name: 'server', type: 'json', describe: 'The server as it was when the capture began, with the fingerprint of how it runs.' },
      { name: 'reason', type: 'text', describe: 'Why it could not be opened.' },
    ],
    exits: [
      { name: 'hosted', describe: 'It is hosted: at a URL, or one of the person\'s deployments.' },
      { name: 'workspace', describe: 'It runs in a workspace, so its image is built and it is started there.' },
      { name: 'missing', describe: 'There is no such server.' },
    ],
    settings: NONE,
    summary: 'reads the server from the catalogue',
    idempotent: true,
  },
  {
    name: 'mcp.connect',
    title: 'Ask a Hosted Server',
    group: 'MCP servers',
    describe: 'Connects to a hosted server and asks what it says about itself and which tools it serves.',
    inputs: [SERVER],
    outputs: [
      { name: 'captured', type: 'json', describe: 'Its instructions, who it says it is, and its tools.' },
      { name: 'reason', type: 'text', describe: 'Why it did not answer.' },
    ],
    exits: [
      { name: 'captured', describe: 'It answered.' },
      { name: 'failed', describe: 'It could not be reached, or did not answer as an MCP server.' },
    ],
    settings: NONE,
    summary: 'asks a hosted server what it serves',
    idempotent: true,
  },
  {
    name: 'mcp.build',
    title: 'Build Server Image',
    group: 'MCP servers',
    describe: 'Composes the smallest workspace that has what the server needs and builds its image, or finds it already built.',
    inputs: [SERVER],
    outputs: [
      { name: 'image', type: 'text', describe: 'The image the server runs in.' },
      { name: 'reason', type: 'text', describe: 'Why it could not be built.' },
    ],
    exits: [
      { name: 'built', describe: 'The image is built.' },
      { name: 'failed', describe: 'What it needs cannot be put together, or the build failed.' },
    ],
    settings: NONE,
    summary: 'builds the server\'s image',
    idempotent: true,
  },
  {
    name: 'mcp.start',
    title: 'Start and Ask the Server',
    group: 'MCP servers',
    describe: 'Starts the server in this run\'s own sandbox, in its image, and asks what it says about itself and which tools it serves. The sandbox goes when the run ends.',
    inputs: [SERVER, { name: 'image', type: 'text', describe: 'The image Build Server Image built.', required: true }],
    outputs: [
      { name: 'captured', type: 'json', describe: 'Its instructions, who it says it is, and its tools.' },
      { name: 'reason', type: 'text', describe: 'Why it did not start or answer, with the end of its log.' },
    ],
    exits: [
      { name: 'captured', describe: 'It started and answered.' },
      { name: 'failed', describe: 'It did not start, or did not answer as an MCP server.' },
    ],
    settings: NONE,
    summary: 'starts the server and asks what it serves',
    idempotent: true,
  },
  {
    name: 'mcp.release',
    title: 'Release the Capture Sandbox',
    group: 'MCP servers',
    describe: 'Lets go of the sandbox this run started the server in, if it started one. A cleanup step: it runs however the run ends.',
    inputs: [],
    outputs: [],
    exits: [{ name: 'done', describe: 'Nothing of the capture is left running.' }],
    settings: NONE,
    summary: 'lets go of the capture\'s sandbox',
    idempotent: true,
  },
  {
    name: 'mcp.record',
    title: 'Record the Capture',
    group: 'MCP servers',
    describe: 'Keeps what the server said on its record, so runs offer its tools without asking it, or keeps why the capture failed, so it is offered to no one and its agents are told why.',
    inputs: [
      SERVER,
      { name: 'captured', type: 'json', describe: 'What the server said, when it answered.' },
      { name: 'reason', type: 'text', describe: 'Why it failed, when it did.' },
    ],
    outputs: [{ name: 'summary', type: 'text', describe: 'What was recorded, in a line.' }],
    exits: [{ name: 'recorded', describe: 'The record says so.' }],
    settings: {
      type: 'object',
      required: ['what'],
      properties: { what: { type: 'string', title: 'What happened', enum: ['captured', 'failed'] } },
    },
    summary: 'keeps the capture on the server\'s record',
    idempotent: true,
  },
];
