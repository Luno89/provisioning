import type { ActingFor } from '@koala/agent-engine/procedure';

export type MemberReach = 'project' | 'anywhere' | 'denied';

export const MEMBER_REACH: Readonly<Record<string, MemberReach>> = {
  list_files: 'project',
  read_stored_file: 'project',
  store_file: 'project',
  remove_stored_file: 'project',

  claim_leaf: 'project',
  next_leaf_task: 'project',
  propose_leaf_plan: 'project',
  propose_plan: 'project',
  propose_stories: 'project',
  propose_story_cancel: 'project',
  propose_story_change: 'project',
  propose_tree_model: 'project',
  read_tree: 'project',
  ready_leaves: 'project',
  run_tree: 'project',
  settle_leaf: 'project',
  list_tasks: 'project',
  mark_done: 'project',
  mark_failed: 'project',
  start_task: 'project',
  task_status: 'project',
  propose_work: 'project',
  change_workspace: 'project',
  mark_waiting: 'project',

  get_project_env: 'project',
  get_project_pipeline: 'project',
  get_project_url: 'project',
  project_releases: 'project',
  list_project_secrets: 'project',
  request_secret: 'project',
  propose_project_dependency: 'project',
  propose_project_env: 'project',
  read_project_path: 'project',
  app_drift: 'project',
  export_customizations: 'project',
  propose_adopt_customizations: 'project',
  propose_release_change: 'project',

  list_dir: 'project',
  read_file: 'project',
  write_file: 'project',
  delete_file: 'project',
  run_command: 'project',

  search_web: 'anywhere',
  record_verdict: 'anywhere',

  fetch_web_page: 'denied',
  describe_tree_type: 'denied',
  list_tree_types: 'denied',
  app_health: 'denied',
  cluster_health: 'denied',
  monitoring_overview: 'denied',
  propose_alert: 'denied',
  cluster_capacity: 'denied',
  get_events: 'denied',
  get_logs: 'denied',
  inspect_resources: 'denied',
  list_infrastructure: 'denied',
  request_cluster_access: 'denied',
  request_egress: 'denied',
  propose_app_spec: 'denied',
  propose_deploy_app: 'denied',
  propose_deploy_project: 'denied',
  enable_mcp_server: 'denied',
  list_mcp_servers: 'denied',
  propose_mcp_server: 'denied',
  save_memory: 'denied',
  forget_memory: 'denied',
  search_memories: 'denied',
  search_corpus: 'denied',
  ingest_status: 'denied',
  start_ingest: 'denied',
  read_run: 'denied',
  list_checks: 'denied',
  read_check: 'denied',
  read_check_result: 'denied',
  run_check: 'denied',
  write_check: 'denied',
  update_check: 'denied',
  delete_check: 'denied',
  propose_practice: 'denied',
  propose_prompt_change: 'denied',
  propose_scenario: 'denied',
  propose_tool_note: 'denied',
  request_procedure_change: 'denied',
  check_procedure: 'denied',
  list_references: 'denied',
  read_procedure: 'denied',
  save_procedure: 'denied',
};

const ONLY_WITHIN: Readonly<Record<string, { needs?: readonly string[]; never?: readonly string[] }>> = {
  propose_plan: { needs: ['treeId'], never: ['tree'] },
  propose_release_change: { never: ['treeType'] },
  list_tasks: { needs: ['leafId'] },
};

export interface MemberScope {
  projectId: string;
  projectNames: ReadonlySet<string>;
  treeIds: ReadonlySet<string>;
  branchIds: ReadonlySet<string>;
  leafIds: ReadonlySet<string>;
  taskIds: ReadonlySet<string>;
}

const OUTSIDE = 'it names something outside this shared project';

const inSet = (set: ReadonlySet<string>, value: unknown): boolean => typeof value === 'string' && set.has(value);

function outsideArgument(args: Readonly<Record<string, unknown>>, scope: MemberScope): string | undefined {
  const checks: [string, (value: unknown) => boolean][] = [
    ['project', (value) => typeof value === 'string' && scope.projectNames.has(value.trim().toLowerCase())],
    ['projectId', (value) => value === scope.projectId],
    ['treeId', (value) => inSet(scope.treeIds, value)],
    ['branchId', (value) => inSet(scope.branchIds, value)],
    ['leafId', (value) => inSet(scope.leafIds, value)],
    ['leafIds', (value) => Array.isArray(value) && value.every((id) => inSet(scope.leafIds, id))],
    ['taskId', (value) => inSet(scope.taskIds, value)],
  ];
  return checks.find(([name, fits]) => args[name] !== undefined && args[name] !== null && args[name] !== '' && !fits(args[name]))?.[0];
}

export function memberCallProblem(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  scope: MemberScope,
  asker: Pick<ActingFor, 'email' | 'role'>,
  mcp = false,
): string | undefined {
  const reach = mcp ? 'project' : MEMBER_REACH[tool];
  const forWhom = `Koala is answering ${asker.email}, a ${asker.role} on this shared project`;
  if (reach === undefined || reach === 'denied') return `${forWhom}, so it may not use ${tool}, which reaches beyond the project.`;
  if (reach === 'anywhere' || mcp) return undefined;
  const rule = ONLY_WITHIN[tool];
  const forbidden = rule?.never?.find((name) => args[name] !== undefined);
  if (forbidden) return `${forWhom}, so ${tool} may not be given ${forbidden}: ${OUTSIDE}.`;
  const missing = rule?.needs?.find((name) => args[name] === undefined || args[name] === '');
  if (missing) return `${forWhom}, so ${tool} needs ${missing}, one of this project's.`;
  const outside = outsideArgument(args, scope);
  return outside ? `${forWhom}, so ${tool} may not be given that ${outside}: ${OUTSIDE}.` : undefined;
}

export const offeredToMember = (tool: string, mcp = false): boolean => mcp || (MEMBER_REACH[tool] ?? 'denied') !== 'denied';

export const memberAsking = (asker: Pick<ActingFor, 'email' | 'role'>): string =>
  `${asker.email}, a ${asker.role} on this shared project and not its owner,`;

export function memberScopeOf(projectId: string, world: {
  projects: readonly { id: string; name: string; giteaRepo?: string | undefined }[];
  trees: readonly { id: string; projectIds?: string[] | undefined }[];
  branches: readonly { id: string; treeId: string }[];
  leaves: readonly { id: string; branchId: string }[];
  tasks: readonly { id: string; leafId?: string | undefined; projectId?: string | undefined }[];
}): MemberScope {
  const project = world.projects.find((entry) => entry.id === projectId);
  const projectNames = new Set([projectId, ...(project ? [project.name, project.giteaRepo ?? ''] : [])].filter(Boolean).map((name) => name.trim().toLowerCase()));
  const treeIds = new Set(world.trees.filter((tree) => tree.projectIds?.includes(projectId)).map((tree) => tree.id));
  const branchIds = new Set(world.branches.filter((branch) => treeIds.has(branch.treeId)).map((branch) => branch.id));
  const leafIds = new Set(world.leaves.filter((leaf) => branchIds.has(leaf.branchId)).map((leaf) => leaf.id));
  const taskIds = new Set(world.tasks.filter((task) => (task.leafId ? leafIds.has(task.leafId) : task.projectId === projectId)).map((task) => task.id));
  return { projectId, projectNames, treeIds, branchIds, leafIds, taskIds };
}

const HELD_BACK_FROM_OTHERS = new Set(['forget_memory', 'propose_practice', 'propose_prompt_change', 'propose_scenario', 'propose_tool_note', 'request_procedure_change']);

export function keptToProblem(tool: string, args: Readonly<Record<string, unknown>>): string | undefined {
  const why = 'this conversation has messages from people other than the owner of this instance, so only what belongs to its project is remembered from it';
  if (HELD_BACK_FROM_OTHERS.has(tool)) return `${tool} is not used here: ${why}.`;
  if (tool !== 'save_memory') return undefined;
  if (args.scope === 'global') return `save_memory keeps this to the project, never global: ${why}.`;
  if (args.replaces !== undefined && args.replaces !== '') return `save_memory replaces nothing here: ${why}.`;
  return undefined;
}

export const heldBackFromOthers = (tool: string): boolean => HELD_BACK_FROM_OTHERS.has(tool);
