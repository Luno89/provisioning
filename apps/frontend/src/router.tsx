import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
  Navigate,
  type RouterHistory,
} from '@tanstack/react-router';
import { RootLayout } from './RootLayout';
import { AppsRoute, ClustersRoute, NginxRoute, ProjectsRoute, VpsCatalogRoute } from './components/ShellRoutes';
import ChatPage from './components/ChatPage';
import TemporalPanel from './components/TemporalPanel';
import ServicesPanel from './components/ServicesPanel';
import CloudAccounts from './components/CloudAccounts.js';
import MeshDevices from './components/MeshDevices.js';
import { Puzzle } from 'lucide-react';
import ProcedureExplorer from './components/Studio/ProcedureExplorer';
import AgentExplorer from './components/Studio/AgentExplorer';
import ToolExplorer from './components/Studio/ToolExplorer';
import ExtensionsView from './components/Studio/ExtensionsView';
import StudioFrame from './components/Studio/StudioFrame';
import TreeTypes from './components/TreeTypes/index.js';
import SettingsView from './components/SettingsView';

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

export const clustersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clusters',
  component: ClustersRoute,
});

export const appsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/apps',
  component: AppsRoute,
});

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

export const servicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/services',
  component: ServicesPanel,
});

export const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: CloudAccounts,
});

export const meshRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mesh',
  component: MeshDevices,
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

export const routeTree = rootRoute.addChildren([
  handoffRoute,
  indexRoute,
  chatRoute,
  chatConvRoute,
  projectsRoute,
  projectDetailRoute,
  treeDetailRoute,
  treeBranchRoute,
  treeLeafRoute,
  clustersRoute,
  appsRoute,
  nginxRoute,
  temporalRoute,
  servicesRoute,
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
  studioToolPartRoute,
  studioProceduresRoute,
  studioProcedureRoute,
  studioTreeTypesRoute,
  studioTreeTypeRoute,
  studioTreeTypePartRoute,
  studioProcedurePartRoute,
  studioExtensionsRoute,
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
