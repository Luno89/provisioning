import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeProcesses, succeeded } from '../../platform/index.js';
import { TOOLS } from './real-k3s.js';

export interface TestNamespaces {
  name(prefix: string): string;
  removeAll(): Promise<void>;
}

export function testNamespaces(admin: string): TestNamespaces {
  const kubeconfig = join(mkdtempSync(join(tmpdir(), 'koala-test-namespaces-')), 'admin.yaml');
  writeFileSync(kubeconfig, admin, { mode: 0o600 });
  const named: string[] = [];
  return {
    name: (prefix) => {
      const name = `${prefix}-${randomUUID().slice(0, 8)}`;
      named.push(name);
      return name;
    },
    removeAll: async () => {
      if (!named.length) return;
      const kubectl = (...args: string[]) => succeeded(nodeProcesses, { command: TOOLS.kubectl, args: ['--kubeconfig', kubeconfig, ...args] });
      const volumes = (JSON.parse(await kubectl('get', 'persistentvolumes', '-o', 'json')) as { items: { metadata: { name: string }; spec: { claimRef?: { namespace: string } } }[] }).items
        .filter((volume) => named.includes(volume.spec.claimRef?.namespace ?? '')).map((volume) => `persistentvolume/${volume.metadata.name}`);
      for (const namespace of named) await kubectl('delete', 'pods', '--all', '-n', namespace, '--grace-period=0', '--force', '--ignore-not-found', '--wait=false');
      await kubectl('delete', 'namespace', ...named, '--ignore-not-found', '--wait=true');
      if (volumes.length) await kubectl('wait', '--for=delete', ...volumes, '--timeout=720h');
    },
  };
}
