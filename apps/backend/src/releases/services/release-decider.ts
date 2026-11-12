import type { ProjectMetadata } from '../../platform/index.js';
import { treeTypeOfProject } from '../../projects/index.js';
import { releaseDecision, type ReleaseDecision } from '../lib/release-paths.js';

export interface ReleaseDeciderDeps {
  trees: Parameters<typeof treeTypeOfProject>[0];
  changed: (project: Pick<ProjectMetadata, 'giteaOwner' | 'giteaRepo'>, since: string, commit: string) => Promise<string[]>;
}

export const releaseDecider = (deps: ReleaseDeciderDeps) => async (project: ProjectMetadata, since: string, commit: string): Promise<ReleaseDecision> => {
  const releaseWhen = (await treeTypeOfProject(deps.trees, project))?.releaseWhen;
  if (!releaseWhen?.length || !project.giteaOwner || !project.giteaRepo) return { release: true };
  try {
    return releaseDecision(await deps.changed(project, since, commit), releaseWhen, since);
  } catch (err) {
    return { release: false, reason: `what changed since ${since.slice(0, 8)} could not be read, so the build is not released: ${(err as Error).message}` };
  }
};
