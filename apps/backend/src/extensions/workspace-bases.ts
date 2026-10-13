import { BASES, type AgentDefinition, type BaseImage, type ImagePlan, type ToolDefinition } from '@koala/agent-engine';
import { ODOO_BASE } from './odoo/workspace-base.js';
import { composeWorkspace, type ComposedWorkspace } from '../lib/workspace-composition.js';
import type { WorkspaceFile } from '../lib/workspace-file.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';

export const WORKSPACE_BASES: readonly BaseImage[] = [...BASES, ODOO_BASE];

export const composeWithBases = (agent: AgentDefinition, tools: readonly ToolDefinition[], file?: WorkspaceFile | undefined, servers?: readonly McpServerRecord[] | undefined): ComposedWorkspace | undefined =>
  composeWorkspace({ agent, tools, ...(file ? { file } : {}), ...(servers ? { servers } : {}) }, WORKSPACE_BASES);

export const planWorkspace = (agent: AgentDefinition, tools: readonly ToolDefinition[], servers?: readonly McpServerRecord[] | undefined, file?: WorkspaceFile | undefined): ImagePlan | undefined =>
  composeWithBases(agent, tools, file, servers)?.plan;
