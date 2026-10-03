import ClustersView from './ClustersView';
import AppsView from './AppsView';
import NginxView from './NginxView';
import VpsCatalog from './VpsCatalog.js';
import Projects from './Projects/index.js';
import { useShellContext } from './shell-context';

export function ClustersRoute() {
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

export function AppsRoute() {
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

export function NginxRoute() {
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

export function VpsCatalogRoute() {
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

export function ProjectsRoute() {
  const ctx = useShellContext();
  return (
    <Projects
      clusters={ctx?.clusters ?? []}
    />
  );
}
