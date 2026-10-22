import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
  Navigate,
  type RouterHistory,
} from '@tanstack/react-router';
import { RootLayout } from './RootLayout';
import { NginxRoute, ProjectsRoute, VpsCatalogRoute } from './ShellRoutes';
import ChatPage from '../components/ChatPage';
import { TemporalPanel } from '../features/infrastructure';
import { InfrastructureView } from '../features/infrastructure';
import { MonitoringDetailRedirect } from '../features/infrastructure';
import { CloudAccounts } from '../features/infrastructure';
import { MyMachines } from '../features/machines';
import { Cpu, Puzzle } from 'lucide-react';
import ProcedureExplorer from '../components/Studio/ProcedureExplorer';
import AgentExplorer from '../components/Studio/AgentExplorer';
import ToolExplorer from '../components/Studio/ToolExplorer';
import McpServerExplorer from '../components/Studio/McpServerExplorer';
import DependencyExplorer from '../components/Studio/DependencyExplorer';
import ExtensionsView from '../components/Studio/ExtensionsView';
import ModelsView from '../components/Studio/ModelsView';
import StudioFrame from '../components/Studio/StudioFrame';
import { TreeTypes } from '../features/projects';
import SettingsView from './SettingsView';
import { HubJoinRoute, SharedProjectRoute, SharedProjectsRoute } from '../features/hub';

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <Navigate to="/chat" replace />,
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to="/chat" replace />,
});

export const handoffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/handoff',
  component: () => null,
});

export const poolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pool',
  component: () => <Navigate to="/chat" replace />,
});

export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: () => <Navigate to="/chat" replace />,
});

export const removeAccountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/remove-account',
  component: () => <Navigate to="/settings" replace />,
});

export const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatPage,
});

export const chatConvRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat/$conversationId',
  component: ChatPage,
});

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsRoute,
});

export const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/project/$projectId',
  component: ProjectsRoute,
});

export const treeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/tree/$treeId',
  component: ProjectsRoute,
});

export const treeBranchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/tree/$treeId/$branchId',
  component: ProjectsRoute,
});

export const treeLeafRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/tree/$treeId/$branchId/$leafId',
  component: ProjectsRoute,
});

export const projectFilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/project/$projectId/files',
  component: ProjectsRoute,
});

export const treeFilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/tree/$treeId/files',
  component: ProjectsRoute,
});

export const projectReleasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/project/$projectId/releases',
  component: ProjectsRoute,
});

export const treeReleasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/tree/$treeId/releases',
  component: ProjectsRoute,
});

export const projectSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/project/$projectId/settings',
  component: ProjectsRoute,
});

export const treeSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/tree/$treeId/settings',
  component: ProjectsRoute,
});

export const infrastructureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/infrastructure',
  component: InfrastructureView,
});

export const infrastructureTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/infrastructure/$tab',
  component: InfrastructureView,
});

export const infrastructureDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/infrastructure/$kind/$id',
  component: InfrastructureView,
});

const toTab = (tab: string) => () => <Navigate to="/infrastructure/$tab" params={{ tab }} replace />;

export const clustersRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/clusters', component: toTab('clusters') });
export const appsRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/apps', component: toTab('apps') });
export const servicesRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/services', component: toTab('clusters') });
export const runningRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/running', component: toTab('running') });
export const monitoringRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/monitoring', component: () => <Navigate to="/infrastructure" replace /> });

export const monitoringDetailRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/monitoring/$kind/$id', component: MonitoringDetailRedirect });

export const nginxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/nginx',
  component: NginxRoute,
});

export const temporalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/temporal',
  component: TemporalPanel,
});

export const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: CloudAccounts,
});

export const meshRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mesh',
  component: MyMachines,
});

export const engineRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/engine',
  component: () => <Navigate to="/studio/agents" replace />,
});

export const evalsRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evals',
  component: () => <Navigate to="/studio/agents" replace />,
});

export const memoriesRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memories',
  component: () => <Navigate to="/studio/agents/$slug/$part" params={{ slug: 'memory-keeper', part: 'memories' }} replace />,
});

export const treeTypesRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tree-types',
  component: () => <Navigate to="/studio/tree-types" replace />,
});

export const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio',
  component: () => <Navigate to="/studio/agents" replace />,
});

export const studioAgentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/agents',
  component: AgentExplorer,
});

export const studioAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/agents/$slug',
  component: AgentExplorer,
});

export const studioAgentPartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/agents/$slug/$part',
  component: AgentExplorer,
});

export const studioToolPartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/tools/$name/$part',
  component: ToolExplorer,
});

export const studioToolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/tools',
  component: ToolExplorer,
});

export const studioToolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/tools/$name',
  component: ToolExplorer,
});

export const studioMcpServersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/mcp-servers',
  component: McpServerExplorer,
});

export const studioMcpServerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/mcp-servers/$id',
  component: McpServerExplorer,
});

export const studioMcpServerPartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/mcp-servers/$id/$part',
  component: McpServerExplorer,
});

export const studioDependenciesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/dependencies',
  component: DependencyExplorer,
});

export const studioDependencyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/dependencies/$name',
  component: DependencyExplorer,
});

export const studioProceduresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/procedures',
  component: ProcedureExplorer,
});

export const studioProcedureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/procedures/$procedureId',
  component: ProcedureExplorer,
});

export const studioTreeTypesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/tree-types',
  component: TreeTypes,
});

export const studioTreeTypeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/tree-types/$typeId',
  component: TreeTypes,
});

export const studioTreeTypePartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/tree-types/$typeId/$part',
  component: TreeTypes,
});

export const studioProcedurePartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/procedures/$procedureId/$part',
  component: ProcedureExplorer,
});

export const studioExtensionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/extensions',
  component: () => <StudioFrame title="Extensions" icon={Puzzle}><ExtensionsView /></StudioFrame>,
});

export const studioModelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/models',
  component: () => <StudioFrame title="Models" icon={Cpu}><ModelsView /></StudioFrame>,
});

export const oldProcedureRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/$procedureId',
  component: function OldProcedure() {
    const { procedureId } = oldProcedureRedirect.useParams();
    return <Navigate to="/studio/procedures/$procedureId" params={{ procedureId }} replace />;
  },
});

export const vpsCatalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/vps-catalog',
  component: VpsCatalogRoute,
});

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsView,
});

export const groveRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/grove',
  component: () => <Navigate to="/projects" replace />,
});

export const treesRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trees',
  component: () => <Navigate to="/projects" replace />,
});

export const boardRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  component: () => <Navigate to="/projects" replace />,
});

export const sharedProjectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shared',
  component: SharedProjectsRoute,
});

export const sharedProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shared/$id',
  component: SharedProjectRoute,
});

export const hubJoinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hub/join/$token',
  component: HubJoinRoute,
});

export const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/join',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.code === 'string' ? { code: search.code } : {}),
    ...(typeof search.project === 'string' ? { project: search.project } : {}),
  }),
  component: () => null,
});

export const routeTree = rootRoute.addChildren([
  handoffRoute,
  joinRoute,
  sharedProjectsRoute,
  sharedProjectRoute,
  hubJoinRoute,
  poolRoute,
  adminRoute,
  removeAccountRoute,
  indexRoute,
  chatRoute,
  chatConvRoute,
  projectsRoute,
  projectDetailRoute,
  projectFilesRoute,
  treeFilesRoute,
  projectReleasesRoute,
  treeReleasesRoute,
  projectSettingsRoute,
  treeSettingsRoute,
  treeDetailRoute,
  treeBranchRoute,
  treeLeafRoute,
  infrastructureRoute,
  infrastructureTabRoute,
  infrastructureDetailRoute,
  clustersRedirect,
  appsRedirect,
  servicesRedirect,
  runningRedirect,
  monitoringRedirect,
  monitoringDetailRedirect,
  nginxRoute,
  temporalRoute,
  accountsRoute,
  meshRoute,
  engineRedirect,
  evalsRedirect,
  memoriesRedirect,
  treeTypesRedirect,
  studioRoute,
  studioAgentsRoute,
  studioAgentRoute,
  studioAgentPartRoute,
  studioToolsRoute,
  studioToolRoute,
  studioMcpServersRoute,
  studioMcpServerRoute,
  studioMcpServerPartRoute,
  studioDependenciesRoute,
  studioDependencyRoute,
  studioToolPartRoute,
  studioProceduresRoute,
  studioProcedureRoute,
  studioTreeTypesRoute,
  studioTreeTypeRoute,
  studioTreeTypePartRoute,
  studioProcedurePartRoute,
  studioExtensionsRoute,
  studioModelsRoute,
  oldProcedureRedirect,
  vpsCatalogRoute,
  settingsRoute,
  groveRedirect,
  treesRedirect,
  boardRedirect,
]);

export function createProvisioningRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    history: history ?? createHashHistory(),
  });
}

export const router = createProvisioningRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
