import { join, relative } from 'node:path';
import type { TestProject } from 'vitest/node';
import { clusterWide, namespacesOf, volumesOf } from './src/infrastructure/testing/cluster-wide.js';
import { PRIVATE_CLUSTER_FILES, startPrivateClusters, TEST_CHARTS } from './src/infrastructure/testing/private-clusters.js';
import { startK3s } from './src/infrastructure/testing/real-k3s.js';

async function filesOfThisRun(project: TestProject): Promise<string[]> {
  const { vitest } = project;
  if (!('filenamePattern' in vitest)) throw new Error('vitest no longer says which files this run was given (filenamePattern), so the run cannot tell which private clusters to start');
  const filters = (vitest as unknown as { filenamePattern?: string[] }).filenamePattern;
  const specifications = await vitest.globTestSpecifications(filters);
  const running = new Set(specifications.filter((spec) => spec.project.name === project.name).map((spec) => relative(project.config.root, spec.moduleId)));
  return PRIVATE_CLUSTER_FILES.filter((file) => running.has(file));
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const k3s = await startK3s();
  const adminFile = join(k3s.folder, 'admin.yaml');
  const namespaces = await namespacesOf(adminFile);
  const volumes = await volumesOf(adminFile);
  const files = await filesOfThisRun(project);
  const folder = join(k3s.folder, 'private-clusters');
  const clusters = await startPrivateClusters(k3s, files, folder, TEST_CHARTS);
  project.provide('k3s', { admin: k3s.admin, account: k3s.account });
  project.provide('k3sClusterWide', { adminFile, baseline: await clusterWide(adminFile) });
  project.provide('privateClusters', { folder, files });
  return async () => {
    await clusters.removeUntaken();
    const left = (await namespacesOf(adminFile)).filter((name) => !namespaces.includes(name));
    const kept = (await volumesOf(adminFile)).filter((name) => !volumes.includes(name));
    await k3s.stop();
    if (left.length) {
      console.error(`the integration tier left namespaces on its shared k3s: ${left.join(', ')}. A test removes every namespace it makes.`);
      process.exitCode = 1;
    }
    if (kept.length) {
      console.error(`the integration tier left persistent volumes on its shared k3s: ${kept.join(', ')}. A test waits for the volumes its namespaces held to be released (testNamespaces does).`);
      process.exitCode = 1;
    }
  };
}
