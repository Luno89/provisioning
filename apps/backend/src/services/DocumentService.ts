import { pathInRepo, repoForWorkspace, workspaceOwnerOf } from '../engine-host/sandboxes/workspace-repos.js';

export interface OpenedDocument {
  workspace: string;
  path: string;
  owner: string;
  repo: string;
  ref: string;
  content: string;
}

const COMMIT = /^[0-9a-f]{7,40}$/;

export type DocumentRead =
  | { ok: true; document: OpenedDocument }
  | { ok: false; status: 400 | 404; error: string };

export class DocumentService {
  constructor(private readonly deps: {
    owns: (ownerId: string, kind: 'tree' | 'conversation', id: string) => Promise<boolean>;
    read: (ownerId: string, repo: string, path: string, ref: string) => Promise<{ owner: string; repo: string; content: string } | null>;
  }) {}

  /** Reads a saved document at a commit when one is given, falling back to main once that commit is gone, as it is after its branch was merged and deleted. */
  async read(ownerId: string, workspace: string, requested: string, at?: string): Promise<DocumentRead> {
    const owner = workspaceOwnerOf(workspace);
    const repo = repoForWorkspace(workspace);
    if (!owner || !repo) return { ok: false, status: 404, error: `there is no saved workspace called ${workspace}` };
    if (!(await this.deps.owns(ownerId, owner.kind, owner.id))) return { ok: false, status: 404, error: `there is no saved workspace called ${workspace}` };
    const path = pathInRepo(requested);
    if (!path) return { ok: false, status: 400, error: `${requested} is not a path inside the workspace` };
    if (at !== undefined && !COMMIT.test(at)) return { ok: false, status: 400, error: `${at} is not a commit` };
    for (const ref of at ? [at, 'main'] : ['main']) {
      const found = await this.deps.read(ownerId, repo.repo, path, ref);
      if (found) return { ok: true, document: { workspace, path, ref, ...found } };
    }
    return { ok: false, status: 404, error: `${path} has not been saved to ${repo.repo}` };
  }
}
