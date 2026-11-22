import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeRunner, nodeStreams } from '../../platform/index.js';
import { stateLockName } from '../lib/terraform-state.js';
import { testNamespaces } from '../testing/test-namespaces.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess, type Target } from './ClusterAccess.js';
import { StateLocks } from './StateLocks.js';

const TERRAFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../bin/terraform');
const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const NAMESPACE = namespaces.name('state-locks');
const STACK = 'platform-egress';
const target: Target = { clusterId: 'machine-locks', kind: 'machine', kubeconfig: k3s.admin };
const access = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(path.join(tmpdir(), 'koala-state-locks-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS });
const work = mkdtempSync(path.join(tmpdir(), 'koala-state-locks-stack-'));
const kubeconfig = path.join(work, 'admin.yaml');

const stack = (slow: boolean) => JSON.stringify({
  terraform: { backend: { kubernetes: { secret_suffix: `${STACK}-state`, namespace: NAMESPACE, config_path: kubeconfig } } },
  resource: { terraform_data: { thing: { input: 'one', ...(slow ? { provisioner: [{ 'local-exec': { command: 'sleep 600' } }] } : {}) } } },
});

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TF_IN_AUTOMATION: 'true', CHECKPOINT_DISABLE: '1' };
const terraform = (args: string[]) => nodeRunner.run({ command: TERRAFORM, args: [...args, '-no-color'], cwd: work, env });
const leaseHolder = async (): Promise<string> => {
  const read = await access.kubectl(target, ['get', 'lease', stateLockName(STACK), '-n', NAMESPACE, '--ignore-not-found', '-o', 'jsonpath={.spec.holderIdentity}']);
  return read.trim();
};

beforeAll(async () => {
  writeFileSync(kubeconfig, k3s.admin, { mode: 0o600 });
  await access.kubectl(target, ['create', 'namespace', NAMESPACE]);
  writeFileSync(path.join(work, 'main.tf.json'), stack(false));
  const init = await terraform(['init', '-input=false']);
  expect(init.code, init.stderr).toBe(0);
});

afterAll(async () => { await namespaces.removeAll(); }, 0);

describe('the lock on a stack\'s state, when the run that held it was killed', () => {
  it('stays held after real Terraform is killed mid-apply, and is freed for the next run once its holder is known to be gone', async () => {
    writeFileSync(path.join(work, 'main.tf.json'), stack(true));
    const applying = nodeStreams.start({ command: TERRAFORM, args: ['apply', '-auto-approve', '-input=false', '-no-color'], cwd: work, env }, { group: true });
    let ended = false;
    void applying.exited.then(() => { ended = true; });
    while (!ended && (await leaseHolder()) === '') await new Promise((done) => { setTimeout(done, 200); });
    expect(ended).toBe(false);
    applying.stop('SIGKILL');
    await applying.exited;

    expect(await leaseHolder()).not.toBe('');
    writeFileSync(path.join(work, 'main.tf.json'), stack(false));
    const refused = await terraform(['apply', '-auto-approve', '-input=false']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('Error acquiring the state lock');

    const alive = new StateLocks({ access, target: () => target, here: hostname() });
    expect(await alive.freeLeftBehind(NAMESPACE, STACK, true)).toBeUndefined();
    expect(await leaseHolder()).not.toBe('');

    const locks = new StateLocks({ access, target: () => target, here: 'instance-worker-cluster-new' });
    expect(await locks.freeLeftBehind(NAMESPACE, STACK, false)).toMatchObject({ host: hostname() });
    expect(await leaseHolder()).toBe('');

    const next = await terraform(['apply', '-auto-approve', '-input=false']);
    expect(next.code, next.stderr).toBe(0);
    expect(await leaseHolder()).toBe('');
    expect(await locks.freeLeftBehind(NAMESPACE, STACK, false)).toBeUndefined();
  });
});
