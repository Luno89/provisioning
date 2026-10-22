import NginxView from '../components/NginxView';
import VpsCatalog from '../components/VpsCatalog.js';
import Projects from '../components/Projects/index.js';
import { useShellContext } from '../components/shell-context';

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
