import type { EngineExtension } from '@koala/agent-engine/procedure';
import { PLATFORM_PERSONAS } from './personas.js';
import { TASK_TOOLS } from '../../engine-host/tools/task-tools-catalogue.js';
import { WORKSPACE_TOOLS } from '../../engine-host/tools/workspace-tools-catalogue.js';
import { SECRET_TOOLS } from '../../engine-host/tools/secret-tools-catalogue.js';
import { MCP_TOOLS } from '../../engine-host/tools/mcp-tools-catalogue.js';
import { KUBE_TOOLS } from '../../engine-host/tools/kube-tools-catalogue.js';
import { PROJECT_TOOLS } from '../../engine-host/tools/project-tools-catalogue.js';
import { EGRESS_TOOLS } from '../../engine-host/tools/egress-tools-catalogue.js';
import { CORPUS_TOOLS } from '../../engine-host/tools/corpus-tools-catalogue.js';

export const PLATFORM: EngineExtension = {
  id: 'platform',
  title: 'Platform',
  describe: 'The platform\'s own agents and the tools they work with: tasks, the workspace, secrets, MCP servers, the clusters, projects, egress and the corpus.',
  version: '1',
  personas: PLATFORM_PERSONAS,
  tools: [...TASK_TOOLS, ...WORKSPACE_TOOLS, ...SECRET_TOOLS, ...MCP_TOOLS, ...KUBE_TOOLS, ...PROJECT_TOOLS, ...EGRESS_TOOLS, ...CORPUS_TOOLS],
};
