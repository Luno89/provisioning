import { containing, objectWith } from '../../platform/lib/test-matchers.js';
import { describe, expect, it } from 'vitest';
import type { QuestionRequest } from '@koala/agent-engine/procedure';
import type { PublishedWorkspace } from '../../engine/lib/published-workspace.js';
import type { Leaf } from '../../projects/lib/leaves.js';
import { askingNodes, runOnHost } from '../testing/host-op-runs.js';
import { createWorkspaceOperations } from './operations/handlers.js';
import { BUILD_WORKSPACE, DO_NOT_INSTALL, INSTALL_IT } from './procedures.js';

const TREE = { id: 't1', ownerId: 'u1', name: 'Shop', projectIds: ['p1'] };

function build(over: { file?: unknown; answer?: string | undefined; fails?: string | undefined; published?: PublishedWorkspace | undefined } = {}) {
  const saved: PublishedWorkspace[] = [];
  const posted: string[] = [];
  const asked: QuestionRequest[] = [];
  const leaves: Leaf[] = [{ id: 'story', ownerId: 'u1', branchId: 'b1', title: 'Invoice PDF', status: 'pending', waitingFor: { reason: 'waits for wkhtmltopdf', since: 't0' }, createdAt: 't0', updatedAt: 't0' }];
  const grown: string[] = [];
  const operations = createWorkspaceOperations({
    trees: { list: async () => [TREE as never] },
    readFile: async () => JSON.stringify(over.file ?? { packages: { dnf: ['wkhtmltopdf'] } }),
    agentsFor: async () => ['executor'],
    compose: async ({ file }) => {
      const lines = [
        ...((file?.packages?.dnf ?? []).length ? [{ from: 'project', install: { via: 'dnf' as const, packages: file!.packages!.dnf! } }] : []),
        ...(file?.script ? [{ from: 'project', install: { via: 'script' as const, run: file.script } }] : []),
      ];
      return { plan: { base: 'ubi-node', installs: lines.map((line) => line.install), lines, provides: [], fingerprint: JSON.stringify(lines) }, env: [] };
    },
    images: { ensure: async () => { if (over.fails) throw new Error(over.fails); return 'img:new'; } },
    published: { get: async () => over.published, save: async (workspace) => { saved.push(workspace); } },
    waiting: {
      branches: { list: async () => [{ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'Invoices', createdAt: 't0', updatedAt: 't0' }] },
      leaves: { list: async () => leaves, save: async (leaf) => { leaves.splice(0, 1, leaf); } },
      tasks: { list: async () => [], save: async () => undefined },
      grow: async (_ownerId, treeId) => { grown.push(treeId); return { started: true }; },
    },
  });
  const nodes = askingNodes(async (request) => { asked.push(request); return over.answer ? { answered: true, value: over.answer } : { answered: false, reason: 'nobody answered in time' }; });
  const run = () => runOnHost({
    procedure: BUILD_WORKSPACE, operations, nodes, runId: 'workspace-build-t1-abc', agentId: 'workspace', ownerId: 'u1', inputs: { treeId: 't1', commit: 'abc' },
    emit: (event: { type: string; post?: { kind: string } }) => { if (event.type === 'notice' && event.post) posted.push(event.post.kind); },
  });
  return { run, saved, posted, asked, leaves, grown };
}

describe('building a tree\'s workspace', () => {
  it('builds what the project declares, makes it the tree\'s workspace, puts the stories that waited back in line, and tells the channel', async () => {
    const { run, saved, posted, leaves, grown } = build();
    expect(await run()).toMatchObject({ outcome: 'ok', reason: 'the workspace is built and the tree works in it' });
    expect(saved).toEqual([objectWith({ treeId: 't1', image: 'img:new', commit: 'abc', lines: [{ from: 'project', install: { via: 'dnf', packages: ['wkhtmltopdf'] } }] })]);
    expect(posted).toEqual(['workspace-ready']);
    expect(leaves[0]!.waitingFor).toBeUndefined();
    expect(grown).toEqual(['t1']);
  });

  it('builds nothing when the tree already works in exactly this', async () => {
    const lines = [{ from: 'project', install: { via: 'dnf' as const, packages: ['wkhtmltopdf'] } }];
    const published = { ownerId: 'u1', treeId: 't1', file: {}, fingerprint: JSON.stringify(lines), image: 'img:old', provides: [], lines, env: [], baseEnv: [], publishedAt: 't' };
    const { run, saved, posted } = build({ published });
    expect(await run()).toMatchObject({ outcome: 'ok', reason: 'the tree already works in this workspace' });
    expect(saved).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('asks the person before it runs a new install script, offering the two answers, and builds it once approved', async () => {
    const { run, saved, posted, asked } = build({ file: { script: 'curl -fsSL https://x.test | sh' }, answer: INSTALL_IT });
    expect(await run()).toMatchObject({ outcome: 'ok' });
    expect(asked[0]).toMatchObject({ choices: [INSTALL_IT, DO_NOT_INSTALL], prompt: containing('curl -fsSL https://x.test | sh') });
    expect(saved).toHaveLength(1);
    expect(posted).toEqual(['workspace-waiting', 'workspace-ready']);
  });

  it('changes nothing when the script is declined, or nobody answers', async () => {
    for (const answer of [DO_NOT_INSTALL, undefined]) {
      const { run, saved, posted } = build({ file: { script: 'curl -fsSL https://x.test | sh' }, answer });
      expect(await run()).toMatchObject({ outcome: 'refused', reason: 'the install script was declined, so the workspace was not changed' });
      expect(saved).toEqual([]);
      expect(posted).toEqual(['workspace-waiting', 'workspace-failed']);
    }
  });

  it('keeps the workspace the tree had when the image does not build, saying why in the channel, and its stories still wait', async () => {
    const { run, saved, posted, leaves, grown } = build({ fails: 'No match for argument: wkhtmltopdf' });
    expect(await run()).toMatchObject({ outcome: 'failed', reason: 'No match for argument: wkhtmltopdf' });
    expect(saved).toEqual([]);
    expect(posted).toEqual(['workspace-failed']);
    expect(leaves[0]!.waitingFor).toBeDefined();
    expect(grown).toEqual([]);
  });

  it('fails with what is wrong when the file says something a workspace cannot do', async () => {
    const { run, posted } = build({ file: { brew: ['x'] } });
    expect(await run()).toMatchObject({ outcome: 'failed', reason: containing('"brew" is not something') });
    expect(posted).toEqual(['workspace-failed']);
  });
});
