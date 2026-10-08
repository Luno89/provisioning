import path from 'path';
import type { Artifact } from '@koala/agent-engine/procedure';
import type { ToolArtifact } from '@koala/engine-core';
import { TREE_REPO } from '../../lib/plan-documents.js';
import { sanitiseRepoName } from '../../lib/projects.js';

export interface WorkspaceRepo {
  repo: string;
  path: string;
  describe: string;
  commitAs?: string | undefined;
}

const TREE_PREFIX = 'tree-';
const CONVERSATION_PREFIX = 'conversation-';

export const CONVERSATION_DOCUMENTS = '/work';

export const treeWorkspaceRunId = (treeId: string): string => `${TREE_PREFIX}${treeId}`;
export const treeRepoName = (treeId: string): string => sanitiseRepoName(`tree-${treeId}`);

export const conversationWorkspaceRunId = (conversationId: string): string => `${CONVERSATION_PREFIX}${conversationId}`;
export const conversationRepoName = (conversationId: string): string => sanitiseRepoName(`research-${conversationId}`);

export function workspaceOwnerOf(workspaceRunId: string): { kind: 'tree' | 'conversation'; id: string } | undefined {
  if (workspaceRunId.startsWith(TREE_PREFIX)) return { kind: 'tree', id: workspaceRunId.slice(TREE_PREFIX.length) };
  if (workspaceRunId.startsWith(CONVERSATION_PREFIX)) return { kind: 'conversation', id: workspaceRunId.slice(CONVERSATION_PREFIX.length) };
  return undefined;
}

export function pathInRepo(requested: string): string | undefined {
  const normal = path.posix.normalize(requested.replace(/^\/+/, ''));
  if (!normal || normal === '.' || normal.startsWith('..') || normal.split('/').includes('.git')) return undefined;
  return normal;
}

export function repoForWorkspace(workspaceRunId: string): WorkspaceRepo | undefined {
  if (workspaceRunId.startsWith(TREE_PREFIX)) {
    const treeId = workspaceRunId.slice(TREE_PREFIX.length);
    return { repo: treeRepoName(treeId), path: TREE_REPO, describe: `The repository of grove tree ${treeId}` };
  }
  if (workspaceRunId.startsWith(CONVERSATION_PREFIX)) {
    const conversationId = workspaceRunId.slice(CONVERSATION_PREFIX.length);
    return {
      repo: conversationRepoName(conversationId),
      path: CONVERSATION_DOCUMENTS,
      describe: `Documents written in conversation ${conversationId}`,
      commitAs: `conversation ${conversationId}`,
    };
  }
  return undefined;
}

export type WorkspaceRepoResolver = (workspaceRunId: string) => Promise<WorkspaceRepo | undefined>;

export function createWorkspaceRepoResolver(stores: {
  trees: () => Promise<readonly { id: string; ownerId: string; projectIds?: readonly string[] | undefined }[]>;
  projects: () => Promise<readonly { id: string; giteaOwner?: string | undefined; giteaRepo?: string | undefined; name?: string | undefined }[]>;
  accountOf: (ownerId: string) => Promise<string | undefined>;
}): WorkspaceRepoResolver {
  return async (workspaceRunId) => {
    const repo = repoForWorkspace(workspaceRunId);
    const owner = workspaceOwnerOf(workspaceRunId);
    if (!repo || owner?.kind !== 'tree') return repo;
    const tree = (await stores.trees()).find((candidate) => candidate.id === owner.id);
    if (!tree?.projectIds?.length) return repo;
    const [projects, account] = await Promise.all([stores.projects(), stores.accountOf(tree.ownerId)]);
    const project = tree.projectIds
      .map((id) => projects.find((candidate) => candidate.id === id))
      .find((candidate) => candidate?.giteaRepo && candidate.giteaOwner === account);
    return project?.giteaRepo ? { ...repo, repo: project.giteaRepo, describe: `The repository of project ${project.name ?? project.id}` } : repo;
  };
}

export const defaultRepoResolver: WorkspaceRepoResolver = async (workspaceRunId) => repoForWorkspace(workspaceRunId);

const WORK = '/work';

export function placeArtifacts(
  artifacts: readonly ToolArtifact[] | undefined,
  environment: { workspace?: { runId: string } | undefined; scope?: { worktree?: string | undefined } | undefined } | undefined,
): Artifact[] {
  const placed: Artifact[] = [];
  for (const artifact of artifacts ?? []) {
    if (artifact.kind === 'link') {
      placed.push(artifact);
      continue;
    }
    const workspace = environment?.workspace?.runId;
    const repo = workspace ? repoForWorkspace(workspace) : undefined;
    if (!workspace || !repo) continue;
    const absolute = path.posix.isAbsolute(artifact.path)
      ? path.posix.normalize(artifact.path)
      : path.posix.join(WORK, environment?.scope?.worktree ?? '', artifact.path);
    const inRepo = path.posix.relative(repo.path, absolute);
    if (!inRepo || inRepo.startsWith('..')) continue;
    placed.push({ kind: 'file', workspace, path: inRepo });
  }
  return placed;
}
