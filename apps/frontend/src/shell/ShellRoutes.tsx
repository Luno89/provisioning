import { VpsCatalog } from '../features/infrastructure';
import { Projects } from '../features/projects';
import { useShellContext } from '../features/infrastructure';

export function VpsCatalogRoute() {
  return <VpsCatalog />;
}

export function ProjectsRoute() {
  const ctx = useShellContext();
  return (
    <Projects
      clusters={ctx?.clusters ?? []}
    />
  );
}
