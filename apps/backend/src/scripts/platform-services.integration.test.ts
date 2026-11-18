import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { ClusterAccess, type Reach } from '../infrastructure/index.js';
import { startK3s, TOOLS, type RealK3s } from '../infrastructure/testing/real-k3s.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { CannotRollOut } from '../activities/watched-apply.js';
import { platformServices } from './platform-services.js';

const ALL_BUT_JOBS = ['', 'apps', 'networking.k8s.io', 'rbac.authorization.k8s.io', 'policy', 'admissionregistration.k8s.io', 'apiextensions.k8s.io', 'coordination.k8s.io', 'autoscaling', 'discovery.k8s.io', 'storage.k8s.io', 'scheduling.k8s.io', 'events.k8s.io'];

let k3s: RealK3s;
let admin: ClusterAccess;
let own: Reach;

beforeAll(async () => {
  k3s = await startK3s();
  admin = new ClusterAccess({
    here: { koalaMachineId: 'desk', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-platform-step-')),
    processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, serviceAccount: k3s.account,
  });
  own = admin.own();
}, 0);

afterAll(async () => { await k3s?.stop(); }, 0);

async function accountReadingNoJobs(): Promise<string> {
  await admin.apply(own, JSON.stringify({
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'reads-no-jobs' },
    rules: [{ apiGroups: ALL_BUT_JOBS, resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['get'] }],
  }));
  await admin.kubectl(own, ['create', 'serviceaccount', 'step', '-n', 'default']);
  await admin.kubectl(own, ['create', 'clusterrolebinding', 'step', '--clusterrole=reads-no-jobs', '--serviceaccount=default:step']);
  const folder = mkdtempSync(join(tmpdir(), 'koala-step-account-'));
  copyFileSync(k3s.account.caFile, join(folder, 'ca.crt'));
  writeFileSync(join(folder, 'token'), (await admin.kubectl(own, ['create', 'token', 'step', '-n', 'default', '--duration=1h'])).trim(), { mode: 0o600 });
  return folder;
}

function podEnv(): Record<string, string> {
  const dataDir = testDataDir();
  mkdirSync(dataDir, { recursive: true });
  return {
    ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'https://app.koala.dev',
    ROOT_PUBLIC_KEYS: Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64'),
    INSTANCE_MACHINE_ID: 'desk', TERRAFORM_STATE: 'local', POD_NAMESPACE: 'nowrinkles', DATA_DIR: dataDir, CRAWL4AI_API_TOKEN: 'crawlToken40',
    KUBERNETES_SERVICE_HOST: k3s.account.host, KUBERNETES_SERVICE_PORT: k3s.account.port,
  };
}

describe('the platform services step, as the instance chart\'s Job runs it', () => {
  it('says once that what it applies cannot be read while that lasts, finishes the service once it can, and stops at the first service that can never start', async () => {
    const folder = await accountReadingNoJobs();
    await admin.kubectl(own, ['create', 'namespace', 'searxng']);
    await admin.kubectl(own, ['create', 'quota', 'none', '-n', 'searxng', '--hard=pods=0']);
    const said: string[] = [];
    let granted: Promise<string> | undefined;
    const say = (line: string): void => {
      said.push(line);
      if (!granted && line.includes('could not be read')) granted = admin.kubectl(own, ['create', 'clusterrolebinding', 'step-jobs', '--clusterrole=cluster-admin', '--serviceaccount=default:step']);
    };

    const failed = await platformServices(podEnv(), say, folder).then(() => undefined, (err: unknown) => err);
    await granted;

    expect(failed, `the step ended otherwise: ${String((failed as Error | undefined)?.message ?? failed)}`).toBeInstanceOf(CannotRollOut);
    expect((failed as CannotRollOut).what).toBe('SearXNG');
    const unread = said.filter((line) => line.startsWith('[platform] what the egress proxy made could not be read while it applies: '));
    expect(unread, said.join('\n')).toHaveLength(1);
    expect(unread[0]).toMatch(/jobs.* is forbidden/);
    expect(said).toContain('[platform] the egress proxy: ready');
    expect(said.some((line) => line.startsWith('[platform] Crawl4AI'))).toBe(false);
    expect(await admin.kubectl(own, ['get', 'namespaces', '-o', 'name'])).not.toContain('namespace/crawl4ai');
  }, 0);
});
