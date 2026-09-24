import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { liveEngineHost } from './lib/live-engine-host.js';
import { treeWorkspaceRunId } from '../apps/backend/src/engine-host/sandboxes/tree-workspaces.js';
import { workspaceName } from '../apps/backend/src/engine-host/sandboxes/workspace.js';
import type { RunTicket } from '../apps/backend/src/engine-host/temporal/contracts.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const run = promisify(execFile);
const kubectl = (...args: string[]) => run('kubectl', args, { timeout: 60_000 }).then((r) => r.stdout.trim()).catch(() => '');

const ticket = (runId: string, agentSlug: string): RunTicket => ({ runId, depth: 1, ownerId: 'tree-sandbox-integration', agentSlug, trigger: 'agent' });

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();

  const host = liveEngineHost(db);

  const treeId = `live-${Date.now().toString(36)}`;
  const namespace = workspaceName(treeWorkspaceRunId(treeId));
  const ownerId = 'tree-sandbox-integration';

  try {
    console.log(`[1/6] describing the tree sandbox for ${treeId}`);
    const shared = await host.treeWorkspaces.describe({ treeId, ownerId });
    assert.equal(shared.workspace.persistent, true);
    const handle = { id: shared.id, spec: shared.capabilities, workspace: shared.workspace };
    assert.equal(await host.treeWorkspaces.state(treeId), 'none');

    console.log('[2/6] a leaf-executor run writes into it');
    const worker = await host.environments.forRun({ ticket: ticket(`grove-${treeId}-p1-work-leaf-executor-1`, 'leaf-executor'), environment: handle });
    assert.ok(worker, 'the leaf-executor got no sandbox');
    const wrote = await worker.exec({ command: 'mkdir -p /work/repo && echo "the leaf did this" > /work/repo/proof.txt' });
    assert.equal(wrote.exitCode, 0, wrote.stderr);
    assert.equal(await host.treeWorkspaces.state(treeId), 'running');
    assert.equal(await kubectl('get', 'pvc', 'work', '-n', namespace, '-o', 'jsonpath={.status.phase}'), 'Bound');

    console.log('[3/6] a judge run in another run id sees the same file');
    const judge = await host.environments.forRun({ ticket: ticket(`grove-${treeId}-p1-judge-judge-1`, 'judge'), environment: handle });
    assert.ok(judge, 'the judge got no sandbox');
    assert.equal((await judge.exec({ command: 'cat /work/repo/proof.txt' })).stdout.trim(), 'the leaf did this');
    assert.equal(await kubectl('get', 'pods', '-n', namespace, '-o', 'jsonpath={.items[*].metadata.name}'), 'workspace');

    console.log('[4/6] a child releasing leaves it standing');
    await host.environments.release(`grove-${treeId}-p1-judge-judge-1`);
    assert.equal(await host.treeWorkspaces.state(treeId), 'running');

    console.log('[5/6] parking removes the pod and keeps the volume; the next run gets the files back');
    await host.treeWorkspaces.park(treeId);
    assert.equal(await host.treeWorkspaces.state(treeId), 'parked');
    assert.equal(await kubectl('get', 'pvc', 'work', '-n', namespace, '-o', 'jsonpath={.status.phase}'), 'Bound');
    const later = await host.environments.forRun({ ticket: ticket(`grove-${treeId}-p2-work-leaf-executor-1`, 'leaf-executor'), environment: handle });
    assert.ok(later, 'the second pass got no sandbox');
    assert.equal((await later.exec({ command: 'cat /work/repo/proof.txt' })).stdout.trim(), 'the leaf did this');
    assert.equal(await host.treeWorkspaces.state(treeId), 'running');

    console.log('[6/6] releasing deletes the namespace and the volume with it');
    await host.treeWorkspaces.release(treeId);
    await until('the tree namespace to go', async () => (await host.treeWorkspaces.state(treeId)) === 'none');

    console.log('\ntree sandbox: one pod across runs, volume survives a park, release cleans up — PASS');
  } finally {
    await host.treeWorkspaces.release(treeId).catch(() => undefined);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
