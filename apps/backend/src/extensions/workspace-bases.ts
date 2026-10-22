import { BASES, type AgentDefinition, type BaseImage, type ImagePlan, type ToolDefinition, type WorkspaceDependency } from '@koala/agent-engine';
import { SHIPPED_DEPENDENCIES } from './workspace-dependencies.js';
import { ODOO_20_BASE, ODOO_BASE } from './odoo/workspace-base.js';
import { composeWorkspace, type ComposedWorkspace } from '../engine/lib/workspace-composition.js';
import type { WorkspaceFile, McpServerRecord } from '../engine/index.js';

export const WORKSPACE_BASES: readonly BaseImage[] = [...BASES, ODOO_BASE, ODOO_20_BASE];

export const composeWithBases = (agent: AgentDefinition, tools: readonly ToolDefinition[], file?: WorkspaceFile | undefined, servers?: readonly McpServerRecord[] | undefined, dependencies: readonly WorkspaceDependency[] = SHIPPED_DEPENDENCIES): ComposedWorkspace | undefined =>
  composeWorkspace({ agent, tools, ...(file ? { file } : {}), ...(servers ? { servers } : {}), dependencies }, WORKSPACE_BASES);

export const planWorkspace = (agent: AgentDefinition, tools: readonly ToolDefinition[], servers?: readonly McpServerRecord[] | undefined, file?: WorkspaceFile | undefined, dependencies: readonly WorkspaceDependency[] = SHIPPED_DEPENDENCIES): ImagePlan | undefined =>
  composeWithBases(agent, tools, file, servers, dependencies)?.plan;
