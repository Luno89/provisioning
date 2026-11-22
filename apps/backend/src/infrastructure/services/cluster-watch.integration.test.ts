import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { informer, type Listed } from '@koala/provision';
import { until, type Judged } from '@koala/engine-core/until';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { testNamespaces } from '../testing/test-namespaces.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from './ClusterAccess.js';

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
afterAll(async () => { await namespaces.removeAll(); }, 0);

const access = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-watch-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS });
const target = { clusterId: 'watch', kind: 'machine' as const, kubeconfig: k3s.admin };
const kubectl = (...args: string[]) => access.kubectl(target, args);

const shown = (listed: Listed): string => listed.items
  .map((item) => `${item.kind}/${item.metadata?.name}=${(item as { data?: Record<string, string> }).data?.colour ?? ''}`)
  .sort().join(' ');

describe('a Kubernetes informer on a real k3s, through ClusterAccess', () => {
  it('lists what its selector names, then is told each change the cluster makes, and nothing its selector leaves out', async () => {
    const namespace = namespaces.name('informer');
    await kubectl('create', 'namespace', namespace);
    await kubectl('create', 'configmap', 'one', '-n', namespace, '--from-literal=colour=red');
    await kubectl('label', 'configmap', 'one', '-n', namespace, 'koala.app/watched=yes');
    await kubectl('create', 'configmap', 'other', '-n', namespace, '--from-literal=colour=grey');
    const seen: string[] = [];
    let changed: Promise<unknown> | undefined;
    const source = informer(access.chartCluster(target), { kind: 'ConfigMap', path: `/api/v1/namespaces/${namespace}/configmaps`, labelSelector: 'koala.app/watched=yes' });
    const last = await until('the watched config maps', source, (listed): Judged<string> => {
      const now = shown(listed);
      seen.push(now);
      changed ??= (async () => {
        await kubectl('create', 'configmap', 'two', '-n', namespace, '--from-literal=colour=blue');
        await kubectl('label', 'configmap', 'two', '-n', namespace, 'koala.app/watched=yes');
        await kubectl('patch', 'configmap', 'one', '-n', namespace, '-p', '{"data":{"colour":"green"}}');
        await kubectl('delete', 'configmap', 'one', '-n', namespace);
      })();
      return now === 'ConfigMap/two=blue' ? { done: now } : { waiting: now };
    });
    await changed;
    expect(last).toBe('ConfigMap/two=blue');
    expect(seen[0]).toBe('ConfigMap/one=red');
    expect(seen).toContain('ConfigMap/one=green ConfigMap/two=blue');
    expect(seen.join(' ')).not.toContain('other');
  });

  it('breaks, saying the cluster\'s reason, when what it watches can never be listed', async () => {
    const source = informer(access.chartCluster(target), { kind: 'Nothing', path: '/apis/koala.app/v1/nothings' });
    await expect(until('the nothings', source, (): Judged<true> => ({ waiting: 'listed' }))).rejects.toThrow(/^the nothings: Error from server \(NotFound\)/);
  });
});
