import {
  handleListMcpServers, handleEnableMcpServer, handleAddProjectDependency, handleListInfrastructure,
  handleProposeSpec, handleGetLogs, handleListTrees, handleListTreeTypes, handleProposeTree, handleWebSearch,
  handleInspectResources, handleClusterCapacity,
  handleGetProjectPipeline, handleDeployProject, handleGetProjectUrl,
  handleFetchWebPage, handleRequestEscalatedPrivileges, handleGetProjectEnv, handleSetProjectEnv,
  handleRequestSecret, handleInjectSecretToPod, handleGetProjectSecret, handleSetProjectSecret, handleListProjectSecrets,
  type KoalaToolHandler,
} from './koala-tool-handlers.js';

export const KOALA_TOOL_HANDLERS = {
  list_mcp_servers: handleListMcpServers,
  enable_mcp_server: handleEnableMcpServer,
  add_project_dependency: handleAddProjectDependency,
  list_infrastructure: handleListInfrastructure,
  propose_spec: handleProposeSpec,
  get_logs: (ctx, args) => handleGetLogs(ctx, args, 'get_logs'),
  get_events: (ctx, args) => handleGetLogs(ctx, args, 'get_events'),
  inspect_resources: handleInspectResources,
  cluster_capacity: handleClusterCapacity,
  list_trees: handleListTrees,
  list_tree_types: handleListTreeTypes,
  propose_tree: handleProposeTree,
  get_project_pipeline: handleGetProjectPipeline,
  deploy_project: handleDeployProject,
  get_project_url: handleGetProjectUrl,
  request_escalated_privileges: handleRequestEscalatedPrivileges,
  get_project_env: handleGetProjectEnv,
  set_project_env: handleSetProjectEnv,
  request_secret: handleRequestSecret,
  inject_secret_to_pod: handleInjectSecretToPod,
  get_project_secret: handleGetProjectSecret,
  set_project_secret: handleSetProjectSecret,
  list_project_secrets: handleListProjectSecrets,
  web_search: handleWebSearch,
  fetch_web_page: handleFetchWebPage,
} satisfies Record<string, KoalaToolHandler>;

export type KoalaToolName = keyof typeof KOALA_TOOL_HANDLERS;

