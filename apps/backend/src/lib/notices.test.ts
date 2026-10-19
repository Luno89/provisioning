import { describe, it, expect } from 'vitest';
import { grovedTree, postedNotice, releaseNotice, secretNotice, treeNotices, workspaceNotice } from './notices.js';

describe('what a release says in the chat', () => {
  const release = { id: 'r2', projectId: 'p1', commit: '57fce1a0abcd', slot: 'b' as const };

  it('says a preview waits, how its browser tests went, and offers it and the cut over', () => {
    expect(releaseNotice({ ...release, state: 'preview', e2e: { state: 'passed', summary: '2 passed, 0 failed', startedAt: 't' } }, 't1')).toEqual({
      key: 'release:r2:preview',
      kind: 'preview-ready',
      text: 'A preview of 57fce1a0 is ready in slot b; its browser tests passed (2 passed, 0 failed). Look it over, then cut over or discard it on the project\'s card.',
      refs: { projectId: 'p1', releaseId: 'r2', treeId: 't1' },
      actions: ['open-preview', 'cut-over'],
    });
  });

  it('says what went live, and why a release failed with what kept running', () => {
    expect(releaseNotice({ ...release, state: 'live' }, undefined)).toMatchObject({ key: 'release:r2:live', text: '57fce1a0 is live in slot b.', actions: ['open-app'] });
    expect(releaseNotice({ ...release, state: 'failed', reason: 'the upgrade job failed' }, 't1')?.text).toBe('The release of 57fce1a0 failed: the upgrade job failed. What was live keeps running.');
    const restored = { ...release, slot: 'a' as const, restore: { mode: 'copy' as const, version: '20.0', modules: 41 } };
    expect(releaseNotice({ ...restored, state: 'live' }, 't1', 3)).toMatchObject({
      text: 'The client\'s database (Odoo 20.0, 41 modules) is live in slot a, as a copy to work on, with its mail, scheduled jobs and payments switched off; 3 things were made in their app, which Settings lists and can bring into git.',
      actions: ['open-app', 'open-settings'],
    });
    expect(releaseNotice({ ...restored, state: 'live', restore: { ...restored.restore, mode: 'live' } }, 't1', 0)?.text).toContain('as your live system, with its mail and scheduled jobs running; nothing in it was made in their app outside git.');
    expect(releaseNotice({ ...restored, state: 'failed', reason: 'it has modules this project does not' }, 't1')).toMatchObject({ text: 'Starting from the client\'s database failed: it has modules this project does not. Nothing is live yet; Settings says what to do next.', actions: ['open-settings'] });
  });

  it('says nothing while a release is only being prepared or was replaced', () => {
    expect(releaseNotice({ ...release, state: 'preparing' }, 't1')).toBeUndefined();
    expect(releaseNotice({ ...release, state: 'superseded' }, 't1')).toBeUndefined();
  });
});

describe('what a tree says when it stops growing', () => {
  const leaves = [
    { id: 'l1', branchId: 'b1', title: 'The module', status: 'succeeded' as const },
    { id: 'l2', branchId: 'b2', title: 'The proof', status: 'failed' as const, findings: 'the spec could not sign in' },
    { id: 'l3', branchId: 'b2', title: 'Later', status: 'pending' as const },
  ];

  it('sums up what landed, failed and waits, and names each failed leaf', () => {
    const said = treeNotices({ id: 't1', name: 'Shop', projectId: 'p1' }, leaves, { runId: 'grove-run-t1', outcome: 'ok' });
    expect(said.map((notice) => [notice.kind, notice.text])).toEqual([
      ['tree-quiet', 'Work on Shop finished: 1 story landed, 1 failed, 1 still to work.'],
      ['leaf-failed', 'The story "The proof" failed: the spec could not sign in.'],
    ]);
    expect(said[1]!.refs).toEqual({ treeId: 't1', projectId: 'p1', branchId: 'b2', leafId: 'l2' });
    expect(said[1]!.line).toBe('The story "The proof" failed; what went wrong is in its chat.');
  });

  it('says a run that did not finish well stopped, and why', () => {
    expect(treeNotices({ id: 't1', name: 'Shop' }, [], { runId: 'grove-run-t1', outcome: 'failed', reason: 'the workspace could not be built' })[0]!.text)
      .toBe('Work on Shop stopped (failed: the workspace could not be built): 0 stories landed.');
  });

  it('knows a tree\'s own run from any other', () => {
    expect(grovedTree('grove-run-t1', 0)).toBe('t1');
    expect(grovedTree('grove-run-t1~k2x9', 0)).toBe('t1');
    expect(grovedTree('grove-run-t1-grove-leaf-3', 1)).toBeUndefined();
    expect(grovedTree('run-123', 0)).toBeUndefined();
  });
});

describe('a secret only the person can enter', () => {
  it('is named, said what it is for, and leads to where it is entered', () => {
    expect(secretNotice({ id: 'q1', projectId: 'p1', treeId: 't1', key: 'STRIPE_KEY', description: 'From the Stripe dashboard.' })).toEqual({
      key: 'secret:q1', kind: 'secret-needed', text: 'The app needs STRIPE_KEY, which only you can enter: From the Stripe dashboard.',
      refs: { projectId: 'p1', requestId: 'q1', treeId: 't1' }, actions: ['enter-secret'],
    });
  });
});

describe('a notice a run asks to post', () => {
  it('is posted only when it is a notice the platform knows, with just the references and actions it may carry', () => {
    const notice = workspaceNotice('ready', { id: 't1', name: 'Shop', projectId: 'p1' }, { runId: 'r1', summary: 'adds dnf wkhtmltopdf (project)' });
    expect(postedNotice({ ...notice })).toEqual(notice);
    expect(postedNotice({ ...notice, kind: 'made-up' })).toBeUndefined();
    expect(postedNotice({ ...notice, refs: { treeId: 't1', evil: 'x' }, actions: ['open-tree', 'delete-everything'] })).toEqual({ ...notice, refs: { treeId: 't1' }, actions: ['open-tree'] });
    expect(postedNotice(workspaceNotice('failed', { id: 't1', name: 'Shop' }, { runId: 'r1', reason: 'pip: command not found' }) as never)!.actions).toEqual(['open-workspace']);
  });
});
