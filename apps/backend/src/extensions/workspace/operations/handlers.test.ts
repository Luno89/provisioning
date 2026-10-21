import { describe, expect, it } from 'vitest';
import type { NodeRequest } from '@koala/agent-engine/procedure';
import type { PlanLine } from '@koala/agent-engine';
import type { PublishedWorkspace } from '../../../lib/published-workspace.js';
import type { Branch, Leaf } from '../../../lib/leaves.js';
import type { Task } from '../../../engine-host/tools/tasks.js';
import { changesFrom, createWorkspaceOperations, type ComposedPlan, type WorkspaceOperationDeps } from './handlers.js';

const TREE = { id: 't1', ownerId: 'u1', name: 'Shop', projectIds: ['p1'] };
const line = (from: string, packages: string[]): PlanLine => ({ from, install: { via: 'dnf', packages } });
const PLAN: ComposedPlan = { base: 'ubi-node', fingerprint: 'f2', lines: [line('tool:count_lines', ['ripgrep']), line('project', ['wkhtmltopdf'])], provides: ['rg'], env: [{ name: 'SHOP', value: 'demo' }], baseEnv: [] };
const PUBLISHED: PublishedWorkspace = { ownerId: 'u1', treeId: 't1', file: {}, fingerprint: 'f1', image: 'img:1', provides: ['rg'], lines: [line('tool:count_lines', ['ripgrep'])], env: [{ name: 'SHOP', value: 'demo' }], baseEnv: [], publishedAt: 't0' };

function world(over: Partial<WorkspaceOperationDeps> = {}) {
  const saved: PublishedWorkspace[] = [];
  const emitted: unknown[] = [];
  const operations = createWorkspaceOperations({
    trees: { list: async () => [TREE as never] },
    readFile: async () => JSON.stringify({ packages: { dnf: ['wkhtmltopdf'] }, env: [{ name: 'SHOP', value: 'demo' }] }),
    agentsFor: async () => ['executor'],
    compose: async () => ({ plan: { base: PLAN.base, installs: PLAN.lines.map((entry) => entry.install), lines: PLAN.lines, provides: PLAN.provides, fingerprint: PLAN.fingerprint }, env: PLAN.env }),
    images: { ensure: async () => 'img:2' },
    published: { get: async () => PUBLISHED, save: async (workspace) => { saved.push(workspace); } },
    now: () => '2026-10-12T00:00:00Z',
    ...over,
  });
  const run = (name: string, inputs: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, started: Record<string, unknown> = { treeId: 't1', commit: 'abc123' }) =>
    operations[name]!({
      node: { id: name, kind: 'host-op', settings },
      inputs,
      run: { identity: { runId: 'workspace-build-t1-abc123', agentId: 'workspace' }, launch: { ownerId: 'u1' }, inputs: started, emit: (event: unknown) => { emitted.push(event); } },
    } as unknown as NodeRequest) as Promise<{ exit: string; outputs: Record<string, unknown> }>;
  return { run, saved, emitted };
}

const tree = { id: 't1', name: 'Shop', projectId: 'p1' };

describe('reading what a project says its workspace needs', () => {
  it('reads the file from the tree it was started on, at the commit it was started for', async () => {
    expect(await world().run('workspace.read')).toEqual({
      exit: 'read',
      outputs: { tree, file: { packages: { dnf: ['wkhtmltopdf'] }, env: [{ name: 'SHOP', value: 'demo' }] }, commit: 'abc123' },
    });
  });

  it('reads no file as needing nothing, and says what is wrong with one it cannot use', async () => {
    expect((await world({ readFile: async () => undefined }).run('workspace.read')).outputs).toMatchObject({ file: {} });
    expect(await world({ readFile: async () => '{ "brew": [] }' }).run('workspace.read')).toMatchObject({ exit: 'unreadable', outputs: { reason: expect.stringContaining('"brew" is not something') } });
    expect(await world().run('workspace.read', {}, {}, {})).toMatchObject({ exit: 'unreadable', outputs: { reason: 'no treeId was wired in, and the run was not started with one' } });
  });
});

describe('composing the workspace', () => {
  it('says what changes against the published one, and leaves through changed', async () => {
    const composed = await world().run('workspace.compose', { tree, file: {} });
    expect(composed.exit).toBe('changed');
    expect(composed.outputs).toMatchObject({ summary: 'adds dnf wkhtmltopdf (project)', script: '', added: [line('project', ['wkhtmltopdf'])] });
  });

  it('leaves through unchanged when the tree already works in exactly this, and unbuildable with why', async () => {
    expect((await world({ published: { get: async () => ({ ...PUBLISHED, fingerprint: 'f2', lines: PLAN.lines }), save: async () => undefined } }).run('workspace.compose', { tree })).exit).toBe('unchanged');
    expect(await world({ compose: async () => { throw new Error('count_lines needs rg, which nothing installs'); } }).run('workspace.compose', { tree })).toEqual({ exit: 'unbuildable', outputs: { reason: 'count_lines needs rg, which nothing installs' } });
  });

  it('picks out a new install script, which the person has to approve', () => {
    const script = { from: 'project', install: { via: 'script' as const, run: 'curl -fsSL https://x.test | sh' } };
    expect(changesFrom({ ...PLAN, lines: [...PLAN.lines, script] }, PUBLISHED).script).toBe('curl -fsSL https://x.test | sh');
    expect(changesFrom({ ...PLAN, lines: [...PLAN.lines, script] }, { ...PUBLISHED, lines: [script] }).script).toBeUndefined();
    const own = { install: { via: 'script' as const, run: 'make install' }, from: 'tool:pdf_text', dependency: 'pdf-tools', own: true as const };
    const shipped = { install: { via: 'script' as const, run: 'write koala-e2e' }, from: 'project', dependency: 'koala-e2e' };
    expect(changesFrom({ ...PLAN, lines: [...PLAN.lines, own] }, PUBLISHED).script).toBe('make install');
    expect(changesFrom({ ...PLAN, lines: [...PLAN.lines, shipped] }, PUBLISHED).script).toBeUndefined();
  });

  it('calls the first workspace of a tree its first, and notices an environment change alone', () => {
    expect(changesFrom(PLAN, undefined)).toMatchObject({ changed: true, summary: 'adds dnf ripgrep (tool:count_lines); dnf wkhtmltopdf (project)' });
    expect(changesFrom({ ...PLAN, fingerprint: 'f1', lines: PUBLISHED.lines, env: [{ name: 'SHOP', value: 'live' }] }, PUBLISHED)).toMatchObject({ changed: true, summary: 'changes its environment values' });
  });
});

describe('building and publishing it', () => {
  it('builds the plan into an image, or says why it did not build', async () => {
    expect(await world().run('workspace.build', { plan: PLAN })).toEqual({ exit: 'built', outputs: { image: 'img:2' } });
    expect(await world({ images: { ensure: async () => { throw new Error('No match for argument: wkhtmltopdf'); } } }).run('workspace.build', { plan: PLAN })).toEqual({ exit: 'failed', outputs: { reason: 'No match for argument: wkhtmltopdf' } });
  });

  it('records the built image as the tree\'s workspace, with every line and where it came from', async () => {
    const { run, saved } = world();
    await run('workspace.publish', { tree, plan: PLAN, file: { packages: { dnf: ['wkhtmltopdf'] } }, image: 'img:2' });
    expect(saved).toEqual([{
      ownerId: 'u1', treeId: 't1', commit: 'abc123', file: { packages: { dnf: ['wkhtmltopdf'] } }, fingerprint: 'f2', image: 'img:2', provides: ['rg'], lines: PLAN.lines,
      env: [{ name: 'SHOP', value: 'demo' }], baseEnv: [], publishedAt: '2026-10-12T00:00:00Z', runId: 'workspace-build-t1-abc123',
    }]);
  });

  it('records how far the next build has got on the tree\'s workspace, for the runs in it to be told', async () => {
    const { run, saved } = world();
    await run('workspace.read');
    expect(saved).toEqual([]);
    await run('workspace.compose', { tree, file: {} });
    await run('workspace.notify', { tree, reason: 'No match for argument: jq' }, { what: 'failed' });
    expect(saved.map((entry) => entry.next)).toEqual([
      { runId: 'workspace-build-t1-abc123', commit: 'abc123', stage: 'building', at: '2026-10-12T00:00:00Z' },
      { runId: 'workspace-build-t1-abc123', commit: 'abc123', stage: 'failed', reason: 'No match for argument: jq', at: '2026-10-12T00:00:00Z' },
    ]);
    expect(saved.every((entry) => entry.image === PUBLISHED.image)).toBe(true);
  });

  it('tells the project\'s channel, with a notice the backend posts', async () => {
    const { run, emitted } = world();
    await run('workspace.notify', { tree, summary: 'adds dnf wkhtmltopdf (project)' }, { what: 'ready' });
    expect(emitted).toEqual([expect.objectContaining({
      type: 'notice',
      post: expect.objectContaining({ key: 'workspace:workspace-build-t1-abc123:ready', kind: 'workspace-ready', refs: { treeId: 't1', projectId: 'p1' }, text: expect.stringContaining('The workspace for Shop is ready: adds dnf wkhtmltopdf (project)') }),
    })]);
  });
});

describe('putting the stories that waited back in line', () => {
  const branch = (id: string, treeId: string): Branch => ({ id, ownerId: 'u1', treeId, title: id, createdAt: 't0', updatedAt: 't0' });
  const leaf = (id: string, branchId: string, over: Partial<Leaf> = {}): Leaf => ({ id, ownerId: 'u1', branchId, title: `story ${id}`, status: 'pending', createdAt: 't0', updatedAt: 't0', ...over });
  const task = (id: string, leafId: string, status: Task['status']): Task => ({ id, ownerId: 'u1', leafId, title: id, doneMeans: 'x', dependsOn: [], status, runs: [], createdAt: 't0', updatedAt: 't0' });

  function waitingWorld() {
    const leaves = [leaf('parked', 'b1', { waitingFor: { reason: 'waits for jq', since: 't0' } }), leaf('free', 'b1'), leaf('elsewhere', 'b2', { waitingFor: { reason: 'waits for jq', since: 't0' } })];
    const tasks = [task('k1', 'parked', 'waiting'), task('k2', 'parked', 'done'), task('k3', 'elsewhere', 'waiting')];
    const grown: string[] = [];
    const { run } = world({
      waiting: {
        branches: { list: async () => [branch('b1', 't1'), branch('b2', 't2')] },
        leaves: { list: async () => leaves, save: async (saved) => { leaves.splice(leaves.findIndex((entry) => entry.id === saved.id), 1, saved); } },
        tasks: { list: async () => tasks, save: async (saved) => { tasks.splice(tasks.findIndex((entry) => entry.id === saved.id), 1, saved); } },
        grow: async (_ownerId, treeId) => { grown.push(treeId); return { started: true }; },
      },
    });
    return { run, leaves, tasks, grown };
  }

  it('clears the tree\'s waiting stories and their waiting tasks, and grows the tree so they are taken up', async () => {
    const { run, leaves, tasks, grown } = waitingWorld();
    expect(await run('workspace.resume', { tree })).toEqual({ exit: 'resumed', outputs: { resumed: ['story parked'] } });
    expect(leaves.find((entry) => entry.id === 'parked')!.waitingFor).toBeUndefined();
    expect(tasks.map((entry) => [entry.id, entry.status])).toEqual([['k1', 'accepted'], ['k2', 'done'], ['k3', 'waiting']]);
    expect(leaves.find((entry) => entry.id === 'elsewhere')!.waitingFor).toBeDefined();
    expect(grown).toEqual(['t1']);
  });

  it('marks the stories that wait as stuck when the build fails or is declined, and clears it when a new build starts', async () => {
    const { run, leaves } = waitingWorld();
    await run('workspace.notify', { tree, reason: 'pip: command not found' }, { what: 'failed' });
    expect(leaves.find((entry) => entry.id === 'parked')!.waitingFor).toMatchObject({ reason: 'waits for jq', stuck: 'not rebuilt: the build failed — pip: command not found' });
    expect(leaves.find((entry) => entry.id === 'elsewhere')!.waitingFor!.stuck).toBeUndefined();
    await run('workspace.notify', { tree }, { what: 'declined' });
    expect(leaves.find((entry) => entry.id === 'parked')!.waitingFor!.stuck).toBe('not being rebuilt: the person declined its install script');
    await run('workspace.compose', { tree, file: {} });
    expect(leaves.find((entry) => entry.id === 'parked')!.waitingFor).toEqual({ reason: 'waits for jq', since: 't0' });
  });

  it('leaves through none, growing nothing, when no story waited', async () => {
    const { run, grown } = waitingWorld();
    await run('workspace.resume', { tree });
    expect(await run('workspace.resume', { tree })).toEqual({ exit: 'none', outputs: { resumed: [] } });
    expect(grown).toEqual(['t1']);
  });
});
