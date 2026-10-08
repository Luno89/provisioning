import { BASES, planFor, type AgentDefinition, type BaseImage, type ImagePlan, type ToolDefinition } from '@koala/agent-engine';
import { ODOO_BASE } from './odoo/workspace-base.js';

export const WORKSPACE_BASES: readonly BaseImage[] = [...BASES, ODOO_BASE];

export const planWorkspace = (agent: AgentDefinition, tools: readonly ToolDefinition[]): ImagePlan | undefined => planFor(agent, tools, WORKSPACE_BASES);
