import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
  Navigate,
} from '@tanstack/react-router';
import { RootLayout, useShellContext } from './RootLayout';
import ChatPage from './components/ChatPage';
import ClustersView from './components/ClustersView';
import AppsView from './components/AppsView';
import NginxView from './components/NginxView';
import TemporalPanel from './components/TemporalPanel';
import ServicesPanel from './components/ServicesPanel';
import CloudAccounts from './components/CloudAccounts.js';
import MeshDevices from './components/MeshDevices.js';
import Lab from './components/Lab';
import Harness from './components/Harness.js';
import { ToolRepoPanel } from './components/ToolRepoPanel.js';
import TreeTypes from './components/TreeTypes/index.js';
import Personas from './components/Personas.js';
import VpsCatalog from './components/VpsCatalog.js';
import Projects from './components/Projects/index.js';
import SettingsView from './components/SettingsView';

function ClustersRoute() {
  const ctx = useShellContext();
  if (!ctx) return null;
  return (
    <ClustersView
      clusters={ctx.clusters}
      onProvision={() => ctx.setShowClusterModal(true)}
      onOpenLogs={(id) => ctx.openDashboard('cluster', id)}
    />
  );
}

function AppsRoute() {
  const ctx = useShellContext();
  if (!ctx) return null;
  return (
    <AppsView
      deployments={ctx.deployments}
      clusters={ctx.clusters}
      onDeploy={() => ctx.setShowAppModal(true)}
      onOpenLogs={(id) => ctx.openDashboard('app', id)}
    />
  );
}

function NginxRoute() {
  const ctx = useShellContext();
  if (!ctx) return null;
  return (
    <NginxView
      editorContent={ctx.editorContent}
      setEditorContent={ctx.setEditorContent}
      loadingNginxConfig={ctx.loadingNginxConfig}
      updateNginxConfig={ctx.updateNginxConfig}
      deployments={ctx.deployments}
      clusters={ctx.clusters}
      vpnDomains={ctx.vpnDomains}
      setVpnDomains={ctx.setVpnDomains}
      onAddRoute={() => ctx.setShowNginxWizard(true)}
    />
  );
}

function VpsCatalogRoute() {
  const ctx = useShellContext();
  if (!ctx) return null;
  return (
    <VpsCatalog
      onDeploy={(offer) => {
        ctx.setWizardPreset({
          provider: offer.provider,
          serverType: offer.planId,
          ...(offer.location ? { location: offer.location } : {}),
        });
        ctx.setShowClusterModal(true);
      }}
    />
  );
}

function ProjectsRoute() {
  const ctx = useShellContext();
  return (
    <Projects
      clusters={ctx?.clusters ?? []}
      handoff={ctx?.handoff}
      onHandoffTaken={() => ctx?.setHandoff(undefined)}
    />
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <Navigate to="/chat" replace />,
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to="/chat" replace />,
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

export const labRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lab',
  component: Lab,
});

export const harnessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/harness',
  component: Harness,
});

export const toolRepoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tool-repo',
  component: ToolRepoPanel,
});

export const treeTypesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tree-types',
  component: TreeTypes,
});

export const personasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/personas',
  component: Personas,
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
  labRoute,
  harnessRoute,
  toolRepoRoute,
  treeTypesRoute,
  personasRoute,
  vpsCatalogRoute,
  settingsRoute,
  groveRedirect,
  treesRedirect,
  boardRedirect,
]);

export function createProvisioningRouter(history?: any) {
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
