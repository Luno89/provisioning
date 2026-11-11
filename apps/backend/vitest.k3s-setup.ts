import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { clusterWide, namespacesOf, volumesOf } from './src/infrastructure/testing/cluster-wide.js';
import { startK3s } from './src/infrastructure/testing/real-k3s.js';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const k3s = await startK3s();
  const adminFile = join(k3s.folder, 'admin.yaml');
  const namespaces = await namespacesOf(adminFile);
  const volumes = await volumesOf(adminFile);
  project.provide('k3s', { admin: k3s.admin, account: k3s.account });
  project.provide('k3sClusterWide', { adminFile, baseline: await clusterWide(adminFile) });
  return async () => {
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
