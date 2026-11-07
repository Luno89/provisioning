import { VpsCatalog } from '../features/infrastructure';
import { Projects } from '../features/projects';
import { useShellContext } from '../features/infrastructure';

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
