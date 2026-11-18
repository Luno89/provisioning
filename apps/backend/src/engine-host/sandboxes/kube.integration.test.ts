import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, inject, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nodeStreams } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { startedMachine } from '../../infrastructure/lib/cluster-places.js';
import { testClusterAccess } from '../../infrastructure/testing/cluster-access.js';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { EXEC_PIDS, GROUPED_EXEC, STOP_GROUPED_EXEC } from './cluster-backend.js';
import { createKubeRunner, createKubeStreamer, type KoalasCluster, type KubeRunner } from './kube.js';
import { SEND_IN } from './workspace-documents.js';

const running = (command: string): KoalasCluster => ({ start: async (args, io) => nodeStreams.start({ command, args }, io) });

describe('running kubectl', () => {
  let binDir: string;
  let kubectl: string;

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-kubectl-'));
    kubectl = path.join(binDir, 'kubectl');
    await fs.writeFile(kubectl, '#!/bin/sh\necho "started $*"\nexec sleep "$1"\n', { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it('stops a call at the limit its caller set, and says it was the limit', async () => {
    const result = await createKubeRunner(running(kubectl))(['5'], undefined, 200);
    expect(result.stopped).toBe('timeout');
    expect(result.stdout).toBe('started 5\n');
  });

  it('lets a call with no limit run until it ends', async () => {
    const result = await createKubeRunner(running(kubectl))(['0.4']);
    expect(result).toEqual({ stdout: 'started 0.4\n', stderr: '', exitCode: 0 });
  });

  it('on a stop, runs the clean-up first and only then lets go of kubectl', async () => {
    const order: string[] = [];
    const stop = new AbortController();
    const call = createKubeRunner(running(kubectl))(['30'], undefined, undefined, {
      signal: stop.signal,
      onStop: async (why) => { order.push(`clean-up for ${why}`); await new Promise((resolve) => setTimeout(resolve, 100)); order.push('cleaned'); },
    });
    setTimeout(() => stop.abort(), 100);
    const result = await call;
    order.push('kubectl ended');

    expect(result.stopped).toBe('cancelled');
    expect(order).toEqual(['clean-up for cancelled', 'cleaned', 'kubectl ended']);
  });
});

describe('the sandbox runner against a real k3s', () => {
  const k3s = inject('k3s');
  const namespace = `sandbox-${randomUUID().slice(0, 8)}`;
  const pod = 'workspace';
  let cluster: KoalasCluster;
  let run: KubeRunner;

  const exec = (...command: string[]): string[] => ['exec', pod, '-n', namespace, '-i', '--', ...command];
  const inPod = async (script: string): Promise<string> => {
    const result = await run(exec('sh', '-c', script));
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout;
  };

  beforeAll(async () => {
    const access = testClusterAccess(await testDatabase());
    const kubeconfig = await access.kubeconfigOf(startedMachine('machine-sandbox', k3s.admin));
    cluster = { start: async (args, io) => nodeStreams.start({ command: TOOLS.kubectl, args: ['--kubeconfig', kubeconfig, ...args] }, io) };
    run = createKubeRunner(cluster);
    for (const step of [
      ['create', 'namespace', namespace],
      ['run', pod, '-n', namespace, '--image=busybox:1.37', '--restart=Never', '--command', '--', 'sleep', '100000'],
      ['wait', `pod/${pod}`, '-n', namespace, '--for=condition=Ready', '--timeout=720h'],
    ]) {
      const done = await run(step);
      if (done.exitCode !== 0) throw new Error(done.stderr);
    }
  });

  afterAll(async () => {
    await run(['delete', 'namespace', namespace, '--wait=true']);
  }, 0);

  it('runs a command in a pod, with its input, and answers what it printed and how it exited', async () => {
    const result = await run(exec('sh', '-c', 'cat; echo said >&2; exit 3'), 'given');
    expect(result).toMatchObject({ stdout: 'given', exitCode: 3 });
    expect(result.stderr).toMatch(/^said\n/);
  });

  it('streams a bundle into a pod the way a workspace is sent one, and back out again, every byte as it was', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-sandbox-stream-'));
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, at) => (at * 7) % 256));
    await fs.writeFile(path.join(folder, 'sent'), bytes);
    const streamer = createKubeStreamer(cluster);
    expect(await streamer.fromFile(exec('sh', '-c', SEND_IN), path.join(folder, 'sent'))).toEqual({ exitCode: 0, stdout: `${bytes.length}\n`, stderr: '' });
    expect(await streamer.toFile(['exec', pod, '-n', namespace, '--', 'cat', '/tmp/koala-restore.bundle'], path.join(folder, 'back'))).toEqual({ exitCode: 0, stderr: '' });
    expect(await fs.readFile(path.join(folder, 'back'))).toEqual(bytes);
  });

  it('stops a command\'s whole process group in the pod when its run is cancelled', async () => {
    const id = randomUUID();
    const stop = new AbortController();
    const call = run(exec('sh', '-c', GROUPED_EXEC, 'sh', id, 'sleep 3001 & sleep 3002; wait'), undefined, undefined, {
      signal: stop.signal,
      onStop: async () => { await run(['exec', pod, '-n', namespace, '--', 'sh', '-c', STOP_GROUPED_EXEC, 'sh', id]); },
    });
    for (;;) {
      if ((await run(exec('test', '-f', `${EXEC_PIDS}/${id}`))).exitCode === 0 && (await inPod('ps')).includes('sleep 3002')) break;
      await new Promise((settle) => setTimeout(settle, 200));
    }
    stop.abort();
    expect((await call).stopped).toBe('cancelled');
    const left = await inPod('ps');
    expect(left).not.toContain('sleep 3001');
    expect(left).not.toContain('sleep 3002');
    expect((await run(exec('test', '-e', `${EXEC_PIDS}/${id}`))).exitCode).not.toBe(0);
  });

  it('says what kubectl said when the cluster refuses', async () => {
    const result = await run(['get', 'namespace', 'nowhere']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('namespaces "nowhere" not found');
  });
});
