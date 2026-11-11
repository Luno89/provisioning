import { changedPaths } from '../lib/release-paths.js';
import type { ProjectMetadata } from '../../platform/index.js';

export interface FileHashes {
  fileHashes(owner: string, name: string, ref: string): Promise<Map<string, string>>;
}

export const changesIn = (gitea: FileHashes) => async (project: Pick<ProjectMetadata, 'giteaOwner' | 'giteaRepo'>, since: string, commit: string): Promise<string[]> => {
  if (!project.giteaOwner || !project.giteaRepo) throw new Error('the project has no repository');
  const [before, after] = await Promise.all([gitea.fileHashes(project.giteaOwner, project.giteaRepo, since), gitea.fileHashes(project.giteaOwner, project.giteaRepo, commit)]);
  return changedPaths(before, after);
};
