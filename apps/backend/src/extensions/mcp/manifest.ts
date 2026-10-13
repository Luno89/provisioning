import type { EngineExtension } from '@koala/agent-engine/procedure';
import { MCP_OPERATIONS } from './operations/declarations.js';
import { MCP_PERSONAS } from './personas.js';
import { CAPTURE_MCP_SERVER } from './procedures.js';

export const MCP: EngineExtension = {
  id: 'mcp',
  title: 'MCP servers',
  describe: 'A catalogue of MCP servers — hosted ones and ones that run in the workspace — each captured when it is added or saved: what it says about itself and the tools it serves, so runs offer them without asking it.',
  version: '1',
  operations: [...MCP_OPERATIONS],
  personas: MCP_PERSONAS,
  procedures: [CAPTURE_MCP_SERVER],
};
