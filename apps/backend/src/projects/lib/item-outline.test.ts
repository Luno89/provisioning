import { describe, it, expect } from 'vitest';
import { featureOutline, storyOutline, type ItemLeaf } from './item-outline.js';

const tree = { id: 't1', name: 'Shop' };
const branch = { id: 'b1', treeId: 't1', title: 'The field' };
const leaf = (over: Partial<ItemLeaf>): ItemLeaf => ({ id: 'l1', branchId: 'b1', title: 'Module installs', status: 'pending', ...over });

describe('what Koala is told about a story', () => {
  it('names the story, where it sits, its brief, what it waits on and its tasks', () => {
    const text = storyOutline(
      leaf({ body: 'Add the field.', dependsOn: ['l0'] }),
      { tree, branch },
      [leaf({ id: 'l0', title: 'Scaffold', status: 'running' })],
      [{ id: 'k1', leafId: 'l1', title: 'Write the model', status: 'done', doneMeans: 'the field exists', evidence: 'tests pass' }, { id: 'k2', leafId: 'l1', title: 'gone', status: 'dropped', doneMeans: '' }, { id: 'k3', leafId: 'lx', title: 'other', status: 'done', doneMeans: '' }],
    );
    expect(text).toContain('Story "Module installs" (l1), in the feature "The field" (b1) of tree "Shop" (t1).');
    expect(text).toContain('Brief: Add the field.');
    expect(text).toContain('Waits on: "Scaffold" (running).');
    expect(text).toContain('  - Write the model [done] — done means: the field exists; evidence: tests pass');
    expect(text).not.toContain('gone');
    expect(text).not.toContain('other');
  });

  it('says what was claimed, what the judge said and what went wrong before', () => {
    const text = storyOutline(
      leaf({ status: 'succeeded', verified: true, landed: { at: 't', outcome: 'merged' }, claim: { evidence: 'odoo-check passed', commit: 'eda3296', at: 't' }, review: { verdict: 'sound', reason: 'the field shows', at: 't' }, attempts: [{ attempt: 1, error: 'module did not install', failedAt: 't' }] }),
      { tree, branch }, [], [],
    );
    expect(text).toContain('State: succeeded, verified, landed (merged).');
    expect(text).toContain('Claimed done at commit eda3296: odoo-check passed');
    expect(text).toContain('The judge\'s verdict: sound — the field shows.');
    expect(text).toContain('  - attempt 1: module did not install');
  });
});

describe('what Koala is told about a feature', () => {
  it('lists its stories and their states', () => {
    expect(featureOutline(branch, tree, [leaf({ status: 'succeeded', verified: true }), leaf({ id: 'l2', title: 'Gone', status: 'cancelled' }), leaf({ id: 'l3', branchId: 'b9' })]))
      .toBe('Feature "The field" (b1) of tree "Shop" (t1).\nIts stories:\n  - Module installs (l1) [succeeded, verified]');
  });
});
