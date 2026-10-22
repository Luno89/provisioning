import { describe, expect, it } from 'vitest';
import type { RunEffort } from '@koala/agent-engine/procedure';
import { TreeWorkspaceService, type TreeWorkspaceDeps } from './TreeWorkspaceService.js';
import { WorkspaceFileService } from '../../engine/services/WorkspaceFileService.js';
import { GiteaConflictError } from './GiteaService.js';
import { WORKSPACE_FILE, type WorkspaceFile } from '../../engine/lib/workspace-file.js';
import type { PublishedWorkspace } from '../../engine/lib/published-workspace.js';

const TREES = [{ id: 't1', ownerId: 'u1' }, { id: 't2', ownerId: 'u2' }];
const PUBLISHED: PublishedWorkspace = {
  ownerId: 'u1', treeId: 't1', commit: 'aaaa', file: {}, fingerprint: 'f1', image: 'reg/ws:f1', provides: [],
  lines: [{ install: { via: 'dnf', packages: ['ripgrep'] }, from: 'tool:count_lines' }], env: [], baseEnv: [], publishedAt: '2026-10-12T10:00:00Z',
};
const effort = (runId: string, finishedAt: string, outcome = 'ok', reason?: string): RunEffort => ({ runId, ownerId: 'u1', agentSlug: 'workspace', procedureId: 'build-workspace', finishedAt, outcome, ...(reason ? { reason } : {}), wallClockMs: 4000 } as unknown as RunEffort);

function world(over: { repo?: Record<string, string>; published?: PublishedWorkspace | undefined; efforts?: RunEffort[]; conflict?: boolean; compose?: TreeWorkspaceDeps['compose'] } = {}) {
  const repo: Record<string, string> = { ...(over.repo ?? {}) };
  const builds: [string, string][] = [];
  let commits = 0;
  const files = new WorkspaceFileService({
    trees: async () => TREES,
    repoOf: async (treeId) => ({ repo: `tree-${treeId}` }),
    read: async (_ownerId, name, path) => repo[`${name}/${path}`],
    write: async (_ownerId, name, path, content) => {
      if (over.conflict) throw new GiteaConflictError(`"${path}" changed on main while it was being written; read it again and retry.`);
      if (repo[`${name}/${path}`] === content) return { changed: false };
      repo[`${name}/${path}`] = content;
      commits += 1;
      return { changed: true, commit: `c0ffee${commits}`.padEnd(40, '0') };
    },
    branch: 'main',
  });
  const service = new TreeWorkspaceService({
    trees: async () => TREES,
    files,
    compose: over.compose ?? (async (_ownerId, _treeId, file: WorkspaceFile) => ({
      plan: {
        base: 'ubi', installs: [], provides: [], fingerprint: 'f2',
        lines: [
          { install: { via: 'dnf', packages: ['ripgrep'] }, from: 'tool:count_lines' },
          ...(file.packages?.pip ? [{ install: { via: 'pip' as const, packages: file.packages.pip }, from: 'project' }] : []),
        ],
      },
      env: file.env ?? [],
    })),
    published: async (ownerId, treeId) => (ownerId === 'u1' && treeId === 't1' ? ('published' in over ? over.published : PUBLISHED) : undefined),
    builds: async () => over.efforts ?? [],
    startBuild: async (_ownerId, treeId, commit) => { builds.push([treeId, commit]); return { started: true, runId: `workspace-build-${treeId}-${commit.slice(0, 12)}` }; },
  });
  return { service, repo, builds };
}

describe('the Workspace section of a tree', () => {
  it('shows the file on main, every line it composes to with its source, the published image and what main adds to it', async () => {
    const { service } = world({ repo: { [`tree-t1/${WORKSPACE_FILE}`]: JSON.stringify({ packages: { pip: ['cowsay'] } }) } });
    const view = await service.view('u1', 't1');
    expect(view).toMatchObject({
      path: WORKSPACE_FILE,
      file: { packages: { pip: ['cowsay'] } },
      composed: { lines: [{ what: 'dnf ripgrep', from: 'tool:count_lines' }, { what: 'pip cowsay', from: 'project' }] },
      published: { image: 'reg/ws:f1', commit: 'aaaa', lines: [{ what: 'dnf ripgrep', from: 'tool:count_lines' }] },
      pending: ['pip cowsay'],
      can: { managers: ['dnf', 'apt', 'pip', 'npm'] },
    });
    expect(view!.can.languages).toContain('python');
  });

  it('is nobody else\'s, and says why a file it cannot use or a workspace it cannot compose is wrong', async () => {
    expect(await world().service.view('u1', 't2')).toBeUndefined();
    expect(await world({ repo: { [`tree-t1/${WORKSPACE_FILE}`]: '{ "brew": [] }' } }).service.view('u1', 't1')).toMatchObject({ unreadable: expect.stringContaining('"brew" is not something') });
    expect(await world({ compose: async () => { throw new Error('count_lines needs rg, which nothing installs'); } }).service.view('u1', 't1')).toMatchObject({ unbuildable: 'count_lines needs rg, which nothing installs' });
  });

  it('lists this tree\'s builds, newest first, and the one under way with its stage', async () => {
    const { service } = world({
      published: { ...PUBLISHED, next: { runId: 'workspace-build-t1-bbbbbbbbbbbb', stage: 'waiting', at: 't' } },
      efforts: [
        effort('workspace-build-t1-aaaaaaaaaaaa', '2026-10-12T09:00:00Z'),
        effort('workspace-build-t1-cccccccccccc', '2026-10-12T11:00:00Z', 'failed', 'pip: command not found'),
        effort('workspace-build-t1-x-dddddddddddd', '2026-10-12T12:00:00Z'),
      ],
    });
    const view = await service.view('u1', 't1');
    expect(view!.builds.map((build) => [build.runId, build.outcome])).toEqual([['workspace-build-t1-cccccccccccc', 'failed'], ['workspace-build-t1-aaaaaaaaaaaa', 'ok']]);
    expect(view!.next).toMatchObject({ runId: 'workspace-build-t1-bbbbbbbbbbbb', stage: 'waiting', text: expect.stringContaining('approve its install script') });
  });

  it('does not call a build under way once it has ended without saying so', async () => {
    const { service } = world({
      published: { ...PUBLISHED, next: { runId: 'workspace-build-t1-bbbbbbbbbbbb', stage: 'building', at: 't' } },
      efforts: [effort('workspace-build-t1-bbbbbbbbbbbb', '2026-10-12T11:00:00Z', 'failed', 'the worker went away')],
    });
    expect((await service.view('u1', 't1'))!.next).toBeUndefined();
  });

  it('commits a saved file to main and starts its build, and starts nothing when nothing changed', async () => {
    const { service, repo, builds } = world();
    const saved = await service.save('u1', 't1', { packages: { pip: ['cowsay'] } }, 'edited in the Studio');
    expect(saved).toMatchObject({ ok: true, committed: true, build: { started: true }, view: { file: { packages: { pip: ['cowsay'] } } } });
    expect(JSON.parse(repo[`tree-t1/${WORKSPACE_FILE}`]!)).toEqual({ packages: { pip: ['cowsay'] } });
    expect(builds).toHaveLength(1);
    expect(await service.save('u1', 't1', { packages: { pip: ['cowsay'] } }, 'again')).toMatchObject({ ok: true, committed: false });
    expect(builds).toHaveLength(1);
  });

  it('refuses a file the workspace cannot use, someone else\'s tree, and a file changed on main meanwhile', async () => {
    expect(await world().service.save('u1', 't1', { env: [{ name: 'API_TOKEN', value: 'x' }] }, 'x')).toMatchObject({ ok: false, status: 400, why: expect.stringContaining('looks like a secret') });
    expect(await world().service.save('u1', 't2', {}, 'x')).toMatchObject({ ok: false, status: 404 });
    expect(await world({ conflict: true }).service.save('u1', 't1', { packages: { pip: ['jq'] } }, 'x')).toMatchObject({ ok: false, status: 409, why: expect.stringContaining('changed on main') });
  });
});
