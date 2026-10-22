import { GiteaConflictError } from '../../projects/index.js';
import { unknownNeeds, unknownNeedsSaid } from '../lib/workspace-dependencies.js';
import { readWorkspaceFile, WORKSPACE_FILE, withChange, workspaceFileProblems, writeWorkspaceFile, type WorkspaceChange, type WorkspaceFile } from '../lib/workspace-file.js';

export interface WorkspaceFileDeps {
  trees: () => Promise<readonly { id: string; ownerId: string }[]>;
  repoOf: (treeId: string) => Promise<{ repo: string } | undefined>;
  read: (ownerId: string, repo: string, path: string, ref: string) => Promise<string | undefined>;
  write: (ownerId: string, repo: string, path: string, content: string, message: string, branch: string) => Promise<{ changed: boolean; commit?: string | undefined }>;
  branch: string;
  dependencies?: ((ownerId: string) => Promise<readonly { name: string }[]>) | undefined;
}

export type WorkspaceFileRead =
  | { ok: true; file: WorkspaceFile; text?: string | undefined; repo: string }
  | { ok: false; why: string };

export type WorkspaceFileWrite =
  | { ok: true; file: WorkspaceFile; added: string[]; written: boolean; commit?: string | undefined }
  | { ok: false; why: string; conflict?: true | undefined };

export class WorkspaceFileService {
  constructor(private readonly deps: WorkspaceFileDeps) {}

  private async repoOf(ownerId: string, treeId: string): Promise<string | { why: string }> {
    const tree = (await this.deps.trees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    if (!tree) return { why: `there is no tree "${treeId}"` };
    const repo = await this.deps.repoOf(treeId);
    return repo ? repo.repo : { why: `tree "${treeId}" has no repository yet, so it has no ${WORKSPACE_FILE}` };
  }

  async read(ownerId: string, treeId: string): Promise<WorkspaceFileRead> {
    const repo = await this.repoOf(ownerId, treeId);
    if (typeof repo !== 'string') return { ok: false, ...repo };
    const text = await this.deps.read(ownerId, repo, WORKSPACE_FILE, this.deps.branch);
    const read = readWorkspaceFile(text);
    if ('problems' in read) return { ok: false, why: `${WORKSPACE_FILE} on ${this.deps.branch} cannot be used: ${read.problems.join('; ')}` };
    return { ok: true, file: read.file, ...(text !== undefined ? { text } : {}), repo };
  }

  async change(ownerId: string, treeId: string, change: WorkspaceChange, said: string): Promise<WorkspaceFileWrite> {
    const current = await this.read(ownerId, treeId);
    if (!current.ok) return current;
    const changed = withChange(current.file, change);
    if ('problems' in changed) return { ok: false, why: changed.problems.join('; ') };
    const unknown = await this.unknownNeeds(ownerId, changed.file);
    if (unknown) return { ok: false, why: unknown };
    if (changed.added.length === 0) return { ok: true, file: current.file, added: [], written: false };
    return this.commit(ownerId, current.repo, changed.file, changed.added, `Workspace: add ${changed.added.join('; ')}\n\n${said}`);
  }

  async save(ownerId: string, treeId: string, value: unknown, said: string): Promise<WorkspaceFileWrite> {
    const problems = workspaceFileProblems(value);
    if (problems.length > 0) return { ok: false, why: problems.join('; ') };
    const unknown = await this.unknownNeeds(ownerId, value as WorkspaceFile);
    if (unknown) return { ok: false, why: unknown };
    const repo = await this.repoOf(ownerId, treeId);
    if (typeof repo !== 'string') return { ok: false, ...repo };
    return this.commit(ownerId, repo, value as WorkspaceFile, [], `Workspace: ${said}`);
  }

  private async unknownNeeds(ownerId: string, file: WorkspaceFile): Promise<string | undefined> {
    if (!this.deps.dependencies || !file.needs?.length) return undefined;
    const catalogue = await this.deps.dependencies(ownerId);
    const unknown = unknownNeeds(file.needs, catalogue);
    return unknown.length ? unknownNeedsSaid(unknown, catalogue) : undefined;
  }

  private async commit(ownerId: string, repo: string, file: WorkspaceFile, added: string[], message: string): Promise<WorkspaceFileWrite> {
    try {
      const written = await this.deps.write(ownerId, repo, WORKSPACE_FILE, writeWorkspaceFile(file), message, this.deps.branch);
      return { ok: true, file, added, written: written.changed, ...(written.commit ? { commit: written.commit } : {}) };
    } catch (err) {
      return { ok: false, why: (err as Error).message, ...(err instanceof GiteaConflictError ? { conflict: true as const } : {}) };
    }
  }
}
