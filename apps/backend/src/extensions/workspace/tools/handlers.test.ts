import { describe, expect, it, vi } from 'vitest';
import type { ToolCallerContext } from '@koala/engine-core';
import type { WorkspaceChange } from '../../../lib/workspace-file.js';
import type { Task } from '../../../engine-host/tools/tasks.js';
import { changeFrom, createWorkspaceTools, type WorkspaceToolDeps } from './handlers.js';

const task = (over: Partial<Task> = {}): Task => ({ id: 'task-1', ownerId: 'u1', leafId: 'leaf-a', title: 'Render the invoice', doneMeans: 'a PDF', dependsOn: [], status: 'running', runs: ['r1'], createdAt: 't0', updatedAt: 't0', ...over });

function world(over: Partial<WorkspaceToolDeps> = {}, tasks: Task[] = [task()]) {
  const changes: { ownerId: string; treeId: string; change: WorkspaceChange; said: string }[] = [];
  const build = vi.fn<WorkspaceToolDeps['build']>(async (_ownerId, treeId, commit) => ({ started: true, runId: `workspace-build-${treeId}-${commit.slice(0, 12)}` }));
  const tools = createWorkspaceTools({
    files: { change: async (ownerId, treeId, change, said) => { changes.push({ ownerId, treeId, change, said }); return { ok: true, file: {}, added: ['dnf jq'], written: true, commit: 'c0ffee1234567890' }; } },
    build,
    binding: async (_ownerId, conversationId) => (conversationId === 'chat-about-t2' ? { treeId: 't2' } : undefined),
    tasks: { list: async (ownerId) => tasks.filter((entry) => entry.ownerId === ownerId), save: async (saved) => { tasks.splice(tasks.findIndex((entry) => entry.id === saved.id), 1, saved); } },
    pending: async (_ownerId, treeId) => (treeId === 't1' ? ['dnf wkhtmltopdf'] : []),
    now: () => 't1',
    ...over,
  });
  const caller: ToolCallerContext = { ownerId: 'u1', agentSlug: 'executor', runId: 'grove-t1-leaf-a', treeId: 't1' };
  const call = (parsed: Record<string, unknown>, by: ToolCallerContext = caller) =>
    tools.change_workspace!({ name: 'change_workspace', parsed, caller: by, driver: undefined });
  const wait = (parsed: Record<string, unknown>, by: ToolCallerContext = caller) =>
    tools.mark_waiting!({ name: 'mark_waiting', parsed, caller: by, driver: undefined });
  return { call, wait, changes, build, tasks };
}

describe('change_workspace', () => {
  it('commits what the run asks for to the tree it works in, and starts the rebuild from that commit', async () => {
    const { call, changes, build } = world();
    const outcome = await call({ why: 'jq: command not found', dnf: ['jq'] });

    expect(changes).toEqual([{ ownerId: 'u1', treeId: 't1', change: { packages: { dnf: ['jq'] } }, said: 'jq: command not found\n\nAsked for by executor in grove-t1-leaf-a.' }]);
    expect(build).toHaveBeenCalledWith('u1', 't1', 'c0ffee1234567890');
    expect(outcome).toMatchObject({ ok: true, digest: 'added dnf jq to the workspace (c0ffee12)' });
    expect(outcome.content).toMatch(/Nothing added is there until it is published/);
  });

  it('finds the tree from the chat it is called in, or the one it names', async () => {
    const { call, changes } = world();
    await call({ why: 'reports', pip: ['pandas'] }, { ownerId: 'u1', agentSlug: 'koala', conversationId: 'chat-about-t2' });
    await call({ why: 'reports', pip: 'pandas, numpy', treeId: 't3' }, { ownerId: 'u1', agentSlug: 'koala' });
    expect(changes.map((change) => [change.treeId, change.change])).toEqual([['t2', { packages: { pip: ['pandas'] } }], ['t3', { packages: { pip: ['pandas', 'numpy'] } }]]);
  });

  it('says a new install script waits for the person', async () => {
    expect((await world().call({ why: 'no package has it', script: 'curl -fsSL https://x.test/install | sh' })).content).toMatch(/waits for the person to approve it/);
  });

  it('commits nothing and builds nothing when the workspace has it all already', async () => {
    const { call, build } = world({ files: { change: async () => ({ ok: true, file: {}, added: [], written: false }) } });
    expect(await call({ why: 'jq', dnf: ['jq'] })).toMatchObject({ ok: true, digest: 'the workspace has all of it already' });
    expect(build).not.toHaveBeenCalled();
  });

  it('refuses without a why, without a tree, without anything to add, and passes on why the file refused', async () => {
    const { call } = world({ files: { change: async () => ({ ok: false, why: '"DB_PASSWORD" looks like a secret' }) } });
    expect(await call({ dnf: ['jq'] })).toMatchObject({ ok: false, content: expect.stringContaining('say why') });
    expect(await call({ why: 'x', dnf: ['jq'] }, { ownerId: 'u1' })).toMatchObject({ ok: false, content: expect.stringContaining('name the tree with treeId') });
    expect(await call({ why: 'x' })).toMatchObject({ ok: false, content: expect.stringContaining('say what to add') });
    expect(await call({ why: 'x', env: [{ name: 'DB_PASSWORD', value: 'p' }] })).toMatchObject({ ok: false, content: '"DB_PASSWORD" looks like a secret; nothing was committed' });
  });

  it('says the rebuild is not coming when the extension is switched off', async () => {
    const { call } = world({ build: async () => ({ started: false, reason: 'switched-off' }) });
    expect((await call({ why: 'x', dnf: ['jq'] })).content).toMatch(/switched off/);
  });
});

describe('reading what was asked for', () => {
  it('takes lists as JSON or as text, and env as JSON text', () => {
    expect(changeFrom({ dnf: 'jq ripgrep', languages: ['python'], env: '[{"name":"MODE","value":"test"}]' })).toEqual({ packages: { dnf: ['jq', 'ripgrep'] }, languages: ['python'], env: [{ name: 'MODE', value: 'test' }] });
    expect(changeFrom({ env: [{ name: 'MODE' }] })).toBe('env has to be a list of { name, value }, both text');
    expect(changeFrom({ needs: '["koala-e2e"]' })).toEqual({ needs: ['koala-e2e'] });
  });
});

describe('mark_waiting', () => {
  it('sets the task waiting on what the workspace is still to get, saying so for whoever takes it up', async () => {
    const { wait, tasks } = world();
    const outcome = await wait({ taskId: 'task-1', waitsFor: 'wkhtmltopdf renders the invoice' });
    expect(outcome).toMatchObject({ ok: true, digest: '"Render the invoice" waits for the workspace to get dnf wkhtmltopdf' });
    expect(outcome.content).toMatch(/End your turn now/);
    expect(tasks[0]).toMatchObject({ status: 'waiting', evidence: 'waits for the workspace to get dnf wkhtmltopdf: wkhtmltopdf renders the invoice', updatedAt: 't1' });
  });

  it('refuses when there is nothing to wait for, so a task never waits forever', async () => {
    const { wait, tasks } = world({ pending: async () => [] });
    expect(await wait({ taskId: 'task-1', waitsFor: 'x' })).toMatchObject({ ok: false, content: expect.stringContaining('nothing to wait for') });
    expect(tasks[0]!.status).toBe('running');
  });

  it('refuses a task that is finished, or not there', async () => {
    const { wait } = world({}, [task({ status: 'done' })]);
    expect(await wait({ taskId: 'task-1', waitsFor: 'x' })).toMatchObject({ ok: false, content: '"Render the invoice" is done, so it cannot wait' });
    expect(await wait({ taskId: 'ghost', waitsFor: 'x' })).toMatchObject({ ok: false, content: 'there is no task called "ghost"' });
  });
});
