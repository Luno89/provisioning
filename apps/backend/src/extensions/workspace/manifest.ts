import type { EngineExtension } from '@koala/agent-engine/procedure';
import { WORKSPACE_OPERATIONS } from './operations/declarations.js';
import { WORKSPACE_GRANTS, WORKSPACE_PERSONAS } from './personas.js';
import { WORKSPACE_TOOLS } from './tools/catalogue.js';
import { BUILD_WORKSPACE } from './procedures.js';

export const WORKSPACE: EngineExtension = {
  id: 'workspace',
  title: 'Workspace',
  describe: 'Builds a tree\'s workspace from what its project declares in .koala/workspace.json, composed with its type and its agents\' tools, and makes the tree work in it.',
  version: '1',
  requires: ['grove'],
  operations: [...WORKSPACE_OPERATIONS],
  tools: WORKSPACE_TOOLS,
  personas: WORKSPACE_PERSONAS,
  grants: WORKSPACE_GRANTS,
  procedures: [BUILD_WORKSPACE],
};
