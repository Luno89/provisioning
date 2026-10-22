import type { ImageContent } from '@koala/agent-engine';
import { LANGUAGE_IDS } from '@koala/agent-engine';
import type { RunEffort } from '@koala/agent-engine/procedure';
import {
  PACKAGE_MANAGERS, WORKSPACE_FILE, pendingChanges, type WorkspaceFile, installText, stageText,
  type PublishedWorkspace, isWorkspaceBuildOf, type ComposedWorkspace, type WorkspaceFileRead,
  type WorkspaceFileWrite, type WorkspaceBuildStart,
} from '../../engine/index.js';

export interface TreeWorkspaceDeps {
  trees: () => Promise<readonly { id: string; ownerId: string }[]>;
  files: {
    read(ownerId: string, treeId: string): Promise<WorkspaceFileRead>;
    save(ownerId: string, treeId: string, value: unknown, said: string): Promise<WorkspaceFileWrite>;
  };
  compose(ownerId: string, treeId: string, file: WorkspaceFile): Promise<ComposedWorkspace>;
  published(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined>;
  builds(ownerId: string): Promise<readonly RunEffort[]>;
  startBuild(ownerId: string, treeId: string, commit: string): Promise<WorkspaceBuildStart>;
}

export interface WorkspaceLine {
  what: string;
  from: string;
}

export interface TreeWorkspaceView {
  path: string;
  file?: WorkspaceFile | undefined;
  unreadable?: string | undefined;
  composed?: { lines: WorkspaceLine[]; env: { name: string; value: string }[]; contents: ImageContent[] } | undefined;
  unbuildable?: string | undefined;
  published?: {
    image: string;
    commit?: string | undefined;
    publishedAt: string;
    lines: WorkspaceLine[];
    env: { name: string; value: string }[];
  } | undefined;
  pending: string[];
  next?: { runId: string; stage: string; text: string; commit?: string | undefined; at: string } | undefined;
  builds: { runId: string; outcome: string; reason?: string | undefined; finishedAt?: string | undefined; wallClockMs: number }[];
  can: { managers: readonly string[]; languages: readonly string[] };
}

export type TreeWorkspaceSaved =
  | { ok: true; view: TreeWorkspaceView; committed: boolean; build?: WorkspaceBuildStart | undefined }
  | { ok: false; status: 400 | 404 | 409; why: string };

const lineOf = (line: { install: Parameters<typeof installText>[0]; from: string }): WorkspaceLine => ({ what: installText(line.install), from: line.from });

const BUILDS_SHOWN = 10;

export class TreeWorkspaceService {
  constructor(private readonly deps: TreeWorkspaceDeps) {}

  private async owns(ownerId: string, treeId: string): Promise<boolean> {
    return (await this.deps.trees()).some((tree) => tree.id === treeId && tree.ownerId === ownerId);
  }

  async view(ownerId: string, treeId: string): Promise<TreeWorkspaceView | undefined> {
    if (!(await this.owns(ownerId, treeId))) return undefined;
    const [read, published, efforts] = await Promise.all([
      this.deps.files.read(ownerId, treeId),
      this.deps.published(ownerId, treeId),
      this.deps.builds(ownerId),
    ]);

    let composed: TreeWorkspaceView['composed'];
    let unbuildable: string | undefined;
    if (read.ok) {
      try {
        const plan = await this.deps.compose(ownerId, treeId, read.file);
        composed = { lines: (plan.plan.lines ?? []).map(lineOf), env: plan.env, contents: plan.plan.contents ?? [] };
      } catch (err) {
        unbuildable = (err as Error).message;
      }
    }

    const builds = efforts
      .filter((effort) => isWorkspaceBuildOf(effort.runId, treeId))
      .sort((a, b) => String(b.finishedAt ?? '').localeCompare(String(a.finishedAt ?? '')))
      .slice(0, BUILDS_SHOWN)
      .map((effort) => ({
        runId: effort.runId,
        outcome: effort.outcome,
        ...(effort.reason ? { reason: effort.reason } : {}),
        ...(effort.finishedAt ? { finishedAt: effort.finishedAt } : {}),
        wallClockMs: effort.wallClockMs,
      }));
    const settled = new Set(builds.map((build) => build.runId));

    return {
      path: WORKSPACE_FILE,
      ...(read.ok ? { file: read.file } : { unreadable: read.why }),
      ...(composed ? { composed } : {}),
      ...(unbuildable ? { unbuildable } : {}),
      ...(published ? {
        published: {
          image: published.image,
          ...(published.commit ? { commit: published.commit } : {}),
          publishedAt: published.publishedAt,
          lines: published.lines.map(lineOf),
          env: published.env,
        },
      } : {}),
      pending: read.ok ? pendingChanges(published?.file, read.file) : [],
      ...(published?.next && !(settled.has(published.next.runId) && published.next.stage === 'building') ? {
        next: {
          runId: published.next.runId,
          stage: published.next.stage,
          text: stageText(published.next),
          ...(published.next.commit ? { commit: published.next.commit } : {}),
          at: published.next.at,
        },
      } : {}),
      builds,
      can: { managers: PACKAGE_MANAGERS, languages: LANGUAGE_IDS },
    };
  }

  async save(ownerId: string, treeId: string, file: unknown, said: string): Promise<TreeWorkspaceSaved> {
    if (!(await this.owns(ownerId, treeId))) return { ok: false, status: 404, why: 'Tree not found' };
    const saved = await this.deps.files.save(ownerId, treeId, file, said);
    if (!saved.ok) return { ok: false, status: 'conflict' in saved && saved.conflict ? 409 : 400, why: saved.why };
    const build = saved.written && saved.commit ? await this.deps.startBuild(ownerId, treeId, saved.commit) : undefined;
    const view = await this.view(ownerId, treeId);
    return { ok: true, view: view!, committed: saved.written, ...(build ? { build } : {}) };
  }
}
