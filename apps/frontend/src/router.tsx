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
import EngineRunView from './components/EngineRun/EngineRunView';
import StudioView from './components/Studio/StudioView';
import ProcedurePage from './components/Studio/ProcedurePage';
import TreeTypes from './components/TreeTypes/index.js';
import Memories from './components/Memories.js';
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

export const engineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/engine',
  component: EngineRunView,
});

export const evalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evals',
  component: () => <EngineRunView initialTab="evals" />,
});

export const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio',
  component: StudioView,
});

export const studioProcedureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/$procedureId',
  component: ProcedurePage,
});

export const memoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memories',
  component: Memories,
});

export const treeTypesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tree-types',
  component: TreeTypes,
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
  engineRoute,
  evalsRoute,
  studioRoute,
  studioProcedureRoute,
  memoriesRoute,
  treeTypesRoute,
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
