import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { InfrastructureService } from '../infrastructure/index.js';
import { handedKubeconfig, reachCluster } from './cluster-access.js';

describe('reaching a cluster', () => {
  const written: string[] = [];
  afterEach(() => { for (const path of written.splice(0)) rmSync(path, { force: true }); });

  const infra = (content: string) => ({
    getManagementClusterKubeconfig: async () => content,
    getKubeconfig: async () => content,
  }) as unknown as InfrastructureService;

  it('writes a missing kubeconfig readable by its owner alone', async () => {
    const path = await reachCluster(infra('apiVersion: v1'), { clusterName: `reach-${randomUUID()}`, provider: 'k3d', gpuEnabled: true });
    written.push(path);
    expect(readFileSync(path, 'utf8')).toBe('apiVersion: v1');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('leaves a kubeconfig that is already there as it is', async () => {
    const cluster = { clusterName: `reach-${randomUUID()}`, provider: 'k3d', gpuEnabled: true };
    const path = await reachCluster(infra('first'), cluster);
    written.push(path);
    writeFileSync(path, 'kept', { mode: 0o600 });
    await reachCluster(infra('second'), cluster);
    expect(readFileSync(path, 'utf8')).toBe('kept');
  });
});

describe('a kubeconfig handed to a cluster step', () => {
  it('is written where only its owner reads it, named so it is never taken for a k3d cluster\'s, and replaced by the next one handed over', async () => {
    const clusterId = `machine-${randomUUID()}`;
    const path = await handedKubeconfig(clusterId, 'first');
    expect(path).not.toMatch(/\/kubeconfig-/);
    expect(readFileSync(path, 'utf8')).toBe('first');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await handedKubeconfig(clusterId, 'second')).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('second');
    rmSync(path, { force: true });
  });
});
