import type { EngineExtension } from '@koala/agent-engine/procedure';
import { PLATFORM_PERSONAS } from './personas.js';
import { PLATFORM_OPERATIONS } from './operations/declarations.js';
import { TASK_TOOLS } from '../../engine-host/tools/task-tools-catalogue.js';
import { WORKSPACE_TOOLS } from '../../engine-host/tools/workspace-tools-catalogue.js';
import { SECRET_TOOLS } from '../../engine-host/tools/secret-tools-catalogue.js';
import { MCP_TOOLS } from '../../engine-host/tools/mcp-tools-catalogue.js';
import { KUBE_TOOLS } from '../../engine-host/tools/kube-tools-catalogue.js';
import { PROJECT_TOOLS } from '../../engine-host/tools/project-tools-catalogue.js';
import { EGRESS_TOOLS } from '../../engine-host/tools/egress-tools-catalogue.js';
import { CORPUS_TOOLS } from '../../engine-host/tools/corpus-tools-catalogue.js';
import { RUN_TOOLS } from '../../engine-host/tools/run-tools-catalogue.js';
import { MEMORY_TOOLS } from '../../engine-host/tools/memory-tools-catalogue.js';
import { SCENARIO_TOOLS } from '../../engine-host/tools/scenario-tools-catalogue.js';
import { CHECK_TOOLS } from '../../engine-host/tools/check-tools-catalogue.js';
import { AGENT_CHANGE_TOOLS } from '../../engine-host/tools/agent-change-tools-catalogue.js';
import { VERDICT_TOOLS } from '../../engine-host/tools/verdict-tools-catalogue.js';

export const PLATFORM: EngineExtension = {
  id: 'platform',
  title: 'Platform',
  describe: 'The platform\'s own agents, the tools they work with, and its own nodes (browser tests): tasks, the workspace, secrets, MCP servers, the clusters, projects, egress, the corpus and other runs.',
  version: '1',
  operations: [...PLATFORM_OPERATIONS],
  personas: PLATFORM_PERSONAS,
  tools: [...TASK_TOOLS, ...WORKSPACE_TOOLS, ...SECRET_TOOLS, ...MCP_TOOLS, ...KUBE_TOOLS, ...PROJECT_TOOLS, ...EGRESS_TOOLS, ...CORPUS_TOOLS, ...RUN_TOOLS, ...MEMORY_TOOLS, ...SCENARIO_TOOLS, ...CHECK_TOOLS, ...AGENT_CHANGE_TOOLS, ...VERDICT_TOOLS],
};
