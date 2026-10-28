import { authorize, allowed, type Actions, type Principal, type Resource } from '../../platform/lib/permissions.js';
import type { ActingFor } from '@koala/agent-engine/procedure';

export const PROJECT_REFS = ['projectId', 'project', 'treeId', 'branchId', 'leafId', 'leafIds', 'taskId'] as const;
export type ProjectRef = typeof PROJECT_REFS[number];

export type ToolAccess =
  | { on: 'nothing' }
  | { on: 'install'; action: Actions['install'] }
  | { on: 'self'; action: 'see' | 'change'; noun: string }
  | { on: 'deployment'; action: Actions['deployment'] }
  | { on: 'cluster'; action: Actions['cluster'] }
  | { on: 'project'; action: Actions['project']; ownerOnlyWhen?: readonly string[] | undefined };

const self = (action: 'see' | 'change', noun: string): ToolAccess => ({ on: 'self', action, noun });
const project = (action: Actions['project'], ownerOnlyWhen?: readonly string[]): ToolAccess => ({ on: 'project', action, ...(ownerOnlyWhen ? { ownerOnlyWhen } : {}) });
const NOTHING: ToolAccess = { on: 'nothing' };
const DEPLOYMENT: ToolAccess = { on: 'deployment', action: 'see' };
const CLUSTER: ToolAccess = { on: 'cluster', action: 'see' };

export const TOOL_ACCESS: Readonly<Record<string, ToolAccess>> = {
  search_web: NOTHING,
  fetch_web_page: NOTHING,
  record_verdict: NOTHING,

  request_cluster_access: { on: 'install', action: 'open-platform-namespaces' },

  list_infrastructure: CLUSTER,
  cluster_capacity: CLUSTER,
  cluster_health: CLUSTER,
  monitoring_overview: CLUSTER,
  propose_deploy_app: { on: 'cluster', action: 'deploy-to' },
  get_logs: DEPLOYMENT,
  get_events: DEPLOYMENT,
  inspect_resources: DEPLOYMENT,
  app_health: DEPLOYMENT,
  propose_alert: { on: 'deployment', action: 'change' },

  list_files: project('see'),
  read_stored_file: project('see'),
  store_file: project('change'),
  remove_stored_file: project('change'),
  get_project_pipeline: project('see'),
  get_project_url: project('see'),
  project_releases: project('see'),
  read_project_path: project('see'),
  app_drift: project('see'),
  read_tree: project('see'),
  ready_leaves: project('see'),
  next_leaf_task: project('see'),
  list_tasks: project('see'),
  task_status: project('see'),
  list_dir: project('see'),
  read_file: project('see'),
  list_project_secrets: project('see-secrets'),
  get_project_env: project('see-secrets'),
  request_secret: project('propose'),
  propose_work: project('propose'),
  propose_leaf_plan: project('propose'),
  propose_plan: project('propose', ['tree']),
  propose_stories: project('propose'),
  propose_story_cancel: project('propose'),
  propose_story_change: project('propose'),
  propose_tree_model: project('propose'),
  propose_project_env: project('propose'),
  propose_project_dependency: project('propose'),
  propose_deploy_project: project('propose'),
  propose_adopt_customizations: project('propose'),
  propose_release_change: project('propose', ['treeType']),
  start_task: project('change'),
  mark_done: project('change'),
  mark_failed: project('change'),
  mark_waiting: project('change'),
  claim_leaf: project('change'),
  settle_leaf: project('change'),
  run_tree: project('change'),
  change_workspace: project('change'),
  export_customizations: project('change'),
  run_command: project('change'),
  write_file: project('change'),
  delete_file: project('change'),

  list_tree_types: self('see', 'tree type'),
  describe_tree_type: self('see', 'tree type'),
  propose_app_spec: self('change', 'app spec'),
  list_mcp_servers: self('see', 'MCP server'),
  enable_mcp_server: self('change', 'MCP server'),
  propose_mcp_server: self('change', 'MCP server'),
  request_egress: self('change', 'egress'),
  start_ingest: self('change', 'corpus'),
  ingest_status: self('see', 'corpus'),
  search_corpus: self('see', 'corpus'),
  read_run: self('see', 'run'),
  search_memories: self('see', 'memory'),
  save_memory: self('change', 'memory'),
  forget_memory: self('change', 'memory'),
  propose_practice: self('change', 'practice'),
  propose_tool_note: self('change', 'tool note'),
  propose_scenario: self('change', 'check'),
  list_checks: self('see', 'check'),
  read_check: self('see', 'check'),
  read_check_result: self('see', 'check'),
  write_check: self('change', 'check'),
  update_check: self('change', 'check'),
  run_check: self('change', 'check'),
  delete_check: self('change', 'check'),
  propose_prompt_change: self('change', 'agent'),
  request_procedure_change: self('change', 'procedure'),
  list_references: self('see', 'procedure'),
  read_procedure: self('see', 'procedure'),
  check_procedure: self('see', 'procedure'),
  save_procedure: self('change', 'procedure'),
};

export const OWN_TOOL_ACCESS: ToolAccess = self('change', 'tool');

export const mcpToolAccess = (tool: { effect?: string | undefined }): ToolAccess => project(tool.effect === 'read' ? 'see' : 'change');

export const accessOf = (name: string, tool: { effect?: string | undefined } | undefined, mcp: boolean): ToolAccess =>
  TOOL_ACCESS[name] ?? (mcp ? mcpToolAccess(tool ?? {}) : OWN_TOOL_ACCESS);

export interface ProjectResolution {
  project?: { id: string; ownerId: string } | undefined;
  outside?: string | undefined;
}

export const projectRefsIn = (args: Readonly<Record<string, unknown>>): Partial<Record<ProjectRef, unknown>> =>
  Object.fromEntries(PROJECT_REFS.filter((name) => args[name] !== undefined && args[name] !== null && args[name] !== '').map((name) => [name, args[name]]));

export function resourceFor(access: ToolAccess, ownerId: string, args: Readonly<Record<string, unknown>>, resolved: ProjectResolution): { resource: Resource; action: string } | { outside: string } | undefined {
  switch (access.on) {
    case 'nothing': return undefined;
    case 'install': return { resource: { kind: 'install' }, action: access.action };
    case 'self': return { resource: { kind: 'record', noun: access.noun, ownerId }, action: access.action };
    case 'deployment': return { resource: { kind: 'record', noun: 'deployment', ownerId }, action: access.action === 'see' ? 'see' : 'change' };
    case 'cluster': return { resource: { kind: 'record', noun: 'cluster', ownerId }, action: access.action === 'see' || access.action === 'see-everything' ? 'see' : 'change' };
    case 'project': {
      if (access.ownerOnlyWhen?.some((name) => args[name] !== undefined)) return { resource: { kind: 'record', noun: 'project', ownerId }, action: 'change' };
      if (resolved.outside) return { outside: resolved.outside };
      if (resolved.project) return { resource: { kind: 'project', id: resolved.project.id, ownerId: resolved.project.ownerId }, action: access.action };
      return { resource: { kind: 'record', noun: 'project', ownerId }, action: access.action === 'see' ? 'see' : 'change' };
    }
  }
}

const forWhom = (asker: Pick<ActingFor, 'email' | 'role'>): string => `Koala is answering ${asker.email}, a ${asker.role} on this shared project`;

export function accessProblem(
  tool: string,
  access: ToolAccess,
  principal: Principal,
  ownerId: string,
  args: Readonly<Record<string, unknown>>,
  resolved: ProjectResolution,
  asker?: Pick<ActingFor, 'email' | 'role'> | undefined,
): string | undefined {
  const target = resourceFor(access, ownerId, args, resolved);
  if (!target) return undefined;
  if ('outside' in target) {
    return asker
      ? `${forWhom(asker)}, so ${tool} may not be given that ${target.outside}: it names something outside this shared project.`
      : `${tool} may not be given that ${target.outside}: it names nothing of yours.`;
  }
  const decision = authorize(principal, target.action as never, target.resource);
  if (decision.allowed) return undefined;
  if (!asker) return `${tool} was not run: ${decision.error}`;
  if (target.resource.kind === 'project' && decision.status === 403) return `${forWhom(asker)}, so it may not use ${tool} here: ${decision.error}`;
  const named = PROJECT_REFS.find((name) => args[name] !== undefined && args[name] !== null && args[name] !== '');
  if (target.resource.kind === 'project' && named) return `${forWhom(asker)}, so ${tool} may not be given that ${named}: it names something outside this shared project.`;
  return `${forWhom(asker)}, so it may not use ${tool}, which reaches beyond the project.`;
}

export function offerable(access: ToolAccess, principal: Principal, ownerId: string, projectId?: string | undefined): boolean {
  switch (access.on) {
    case 'nothing': return true;
    case 'install': return allowed(principal, access.action, { kind: 'install' });
    case 'self':
    case 'deployment':
    case 'cluster': return principal.id === ownerId;
    case 'project': return principal.id === ownerId || (projectId !== undefined && allowed(principal, access.action, { kind: 'project', id: projectId, ownerId }));
  }
}

export const withheldWhy = (asker: Pick<ActingFor, 'email'> | undefined): string =>
  asker ? `it reaches beyond the shared project ${asker.email} is on` : 'it reaches beyond what this run may do';

export function grantProblem(tool: string, access: ToolAccess, granter: Principal, ownerId: string): string | undefined {
  if (offerable(access, granter, ownerId)) return undefined;
  const target = resourceFor(access, ownerId, {}, {});
  const said = target && !('outside' in target) ? authorize(granter, target.action as never, target.resource) : undefined;
  return `you cannot give an agent ${tool}, which you could not use yourself${said && !said.allowed ? `: ${said.error}` : ''}`;
}
