import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { timeSkippingTestEnvironment } from './temporal-test-env.js';
import { startedFor } from '../platform/lib/workflow-owner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await timeSkippingTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

interface Script {
  undelivered?: number;
  sshTries?: number;
  dnsTries?: number;
  releaseTries?: number;
  bootstrapFails?: string;
  reverseTries?: number;
}

function activities(script: Script, done: string[]) {
  let follows = 0;
  let sshes = 0;
  let dns = 0;
  let releases = 0;
  let reverses = 0;
  return {
    ServerOrderFollowActivity: async () => { follows += 1; done.push('follow'); return { delivered: follows > (script.undelivered ?? 0) }; },
    ServerOrderRebuildActivity: async () => { done.push('rebuild'); return { ip: '203.0.113.7' }; },
    ServerOrderSshActivity: async () => { sshes += 1; done.push('ssh'); return sshes > (script.sshTries ?? 0); },
    ServerOrderDnsActivity: async () => { dns += 1; done.push('dns'); return dns > (script.dnsTries ?? 0); },
    ServerOrderReleaseActivity: async () => { releases += 1; done.push('release'); return releases > (script.releaseTries ?? 0) ? 'v2026.10.29' : undefined; },
    ServerOrderBootstrapActivity: async (_orderId: string, release: string) => {
      done.push(`bootstrap ${release}`);
      if (script.bootstrapFails) throw ApplicationFailure.nonRetryable(script.bootstrapFails, 'BootstrapFailed');
    },
    ServerOrderReverseDnsActivity: async () => { reverses += 1; done.push('reverse dns'); return reverses > (script.reverseTries ?? 0); },
    ServerOrderMailCheckActivity: async () => { done.push('mail check'); },
    ServerOrderStoppedActivity: async () => { done.push('stopped'); },
    ServerOrderFailedActivity: async (_orderId: string, reason: string) => { done.push(`failed: ${reason}`); },
  };
}

async function run(script: Script): Promise<string[]> {
  const done: string[] = [];
  const taskQueue = `root-node-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'RootNodeWorkflow.ts'), activities: activities(script, done) });
  await worker.runUntil(env.client.workflow.execute('RootNodeWorkflow', { workflowId: `root-node-${taskQueue}`, taskQueue, args: ['order-1'], ...startedFor('op') }));
  return done;
}

describe('following a bought server until root runs on it', () => {
  it('waits for delivery, SSH, the domains and a signed release however long each takes, installs root, then sets its reverse DNS once OVHcloud sees its name and checks its mail', async () => {
    const done = await run({ undelivered: 3, sshTries: 2, dnsTries: 1, releaseTries: 2, reverseTries: 2 });
    expect(done).toEqual([
      'follow', 'follow', 'follow', 'follow',
      'rebuild',
      'ssh', 'ssh', 'ssh',
      'dns', 'dns',
      'release', 'release', 'release',
      'bootstrap v2026.10.29',
      'reverse dns', 'reverse dns', 'reverse dns',
      'mail check',
    ]);
  }, 120_000);

  it('records why when installing root fails, and goes no further', async () => {
    const done = await run({ bootstrapFails: 'Installing root ended with 1' });
    expect(done.at(-1)).toBe('failed: Installing root ended with 1');
  }, 120_000);

  it('records that it stopped following when cancelled, and says the server is still bought', async () => {
    const done: string[] = [];
    const taskQueue = `root-node-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'RootNodeWorkflow.ts'), activities: activities({ undelivered: 1_000_000 }, done) });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('RootNodeWorkflow', { workflowId: `root-node-${taskQueue}`, taskQueue, args: ['order-1'], ...startedFor('op') });
      while (done.filter((step) => step === 'follow').length < 2) await new Promise((wait) => setTimeout(wait, 50));
      await handle.cancel();
      await handle.result();
    });
    expect(done.at(-1)).toBe('stopped');
    expect(done).not.toContain('rebuild');
  }, 120_000);
});
