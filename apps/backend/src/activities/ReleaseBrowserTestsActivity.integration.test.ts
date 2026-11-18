import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, succeeded, type ClusterMetadata } from '../platform/index.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { ClusterAccess } from '../infrastructure/index.js';
import { TOOLS } from '../infrastructure/testing/real-k3s.js';
import { testNamespaces } from '../infrastructure/testing/test-namespaces.js';
import { releaseLoginSecret, vaultDatabaseSecret } from '../releases/index.js';
import { giteaStandIn, type GiteaStandIn } from '../projects/testing/gitea-api.js';
import { createReleaseBrowserTestActivities, namespacedCluster } from './ReleaseBrowserTestsActivity.js';

const COMMIT = 'e'.repeat(40);
let gitea: GiteaStandIn;

beforeAll(async () => {
  gitea = await giteaStandIn({ owner: 'bo', name: 'shop', commit: COMMIT, files: {
    'e2e/sale.spec.ts': "test('sells', async () => {});\n",
    'e2e/odoo.ts': 'export {};\n',
    'addons/shop/__manifest__.py': '{}\n',
  } });
});
afterAll(async () => { await gitea.close(); });

describe('reading a build\'s browser tests through Gitea', () => {
  it('takes the specs and their helpers under e2e/ at the build\'s commit, with the config they run under, and says when there are none', async () => {
    const browser = createReleaseBrowserTestActivities({ cluster: () => { throw new Error('reading specs needs no cluster'); }, specs: async () => gitea.gitea() });
    const read = await browser.readSpecs({ owner: 'bo', repo: 'shop', commit: COMMIT });
    expect('files' in read && read.files.map((file) => file.path)).toEqual(['playwright.config.ts', 'e2e/odoo.ts', 'e2e/sale.spec.ts']);
    expect(await browser.readSpecs({ owner: 'bo', repo: 'shop', commit: 'f'.repeat(40) })).toEqual({ reason: `there are no browser tests in e2e/ at ${'f'.repeat(8)}` });
  });
});

describe('browser tests on a release whose database password the cluster will not hand over', () => {
  const k3s = inject('k3s');
  const namespaces = testNamespaces(k3s.admin);
  const NAMESPACE = namespaces.name('shop');
  const KEY = 'browser-tests-vault-key' as never;
  afterAll(async () => { await namespaces.removeAll(); }, 0);

  it('are unavailable, saying the database\'s password could not be read and why, and run nothing', async () => {
    const adminFile = join(mkdtempSync(join(tmpdir(), 'koala-vault-refused-')), 'admin.yaml');
    writeFileSync(adminFile, k3s.admin, { mode: 0o600 });
    const admin = (...args: string[]) => succeeded(nodeProcesses, { command: TOOLS.kubectl, args: ['--kubeconfig', adminFile, '-n', NAMESPACE, ...args] });
    await admin('create', 'namespace', NAMESPACE);
    await admin('create', 'secret', 'generic', releaseLoginSecret('shop'), '--from-literal=password=p');
    await admin('create', 'serviceaccount', 'releaser');
    await admin('create', 'role', 'reads-its-login', '--verb=get', '--resource=secrets', `--resource-name=${releaseLoginSecret('shop')}`);
    await admin('create', 'rolebinding', 'reads-its-login', '--role=reads-its-login', `--serviceaccount=${NAMESPACE}:releaser`);
    const token = (await admin('create', 'token', 'releaser', '--duration=1h')).trim();
    const limited = k3s.admin.replace(/users:[\s\S]*$/, `users:\n- name: default\n  user:\n    token: ${token}\n`);

    const db = await testDatabase();
    const cluster = { id: 'machine-limited', name: 'limited', provider: 'machine', machineId: 'limited', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(limited, KEY) } as ClusterMetadata;
    await db.infrastructure.saveCluster(cluster);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-vault-access-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    const tests = createReleaseBrowserTestActivities({
      cluster: namespacedCluster(access, async () => { throw new Error('nothing is pulled when nothing runs'); }),
      specs: async () => { throw new Error('the specs are handed over'); },
    });

    const result = await tests.runBrowserTests({
      target: { clusterId: cluster.id, clusterName: cluster.name, provider: 'machine', namespace: NAMESPACE, release: 'shop' },
      ownerId: 'bo', keepUnder: 'r1', slot: 'b', image: 'reg/shop:abc', files: [{ path: 'e2e/sale.spec.ts', content: "test('sells', async () => {});\n" }],
    });
    expect(result.state).toBe('unavailable');
    expect(result.state === 'unavailable' ? result.reason : '').toMatch(new RegExp(`^the database's password could not be read from ${vaultDatabaseSecret('shop').secret}: .*forbidden`, 'i'));
    expect(await admin('get', 'jobs', '-o', 'name')).toBe('');
  });
});

