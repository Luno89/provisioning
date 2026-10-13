import { WORKSPACE_FILE } from './workspace-file.js';

export const WORKSPACE_BUILD_PREFIX = 'workspace-build-';

export interface PushedCommit {
  added?: readonly string[] | undefined;
  modified?: readonly string[] | undefined;
  removed?: readonly string[] | undefined;
}

export const workspaceBuildRunId = (treeId: string, commit: string): string => `${WORKSPACE_BUILD_PREFIX}${treeId}-${commit.slice(0, 12)}`;

export const isWorkspaceBuildOf = (runId: string, treeId: string): boolean => {
  const prefix = `${WORKSPACE_BUILD_PREFIX}${treeId}-`;
  return runId.startsWith(prefix) && /^[0-9a-f]{12}$/.test(runId.slice(prefix.length));
};

export function touchesWorkspaceFile(commits: readonly PushedCommit[]): boolean {
  return commits.some((commit) => [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])].includes(WORKSPACE_FILE));
}
