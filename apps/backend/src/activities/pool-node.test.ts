import { existsSync, readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess } from '../infrastructure/index.js';
import { ADMISSION_CHECK_NAMESPACE, installJob, PoolNode, yaml } from './pool-node.js';

const NODE = 'root';
const IMAGE = { repository: 'reg.test/nowrinkles/app', tag: 'v1' };
const SLOT = { memoryMiB: 6144, cpu: 2, storageGiB: 20 };

function node() {
  const access = mock<ClusterAccess>();
  access.apply.mockResolvedValue('');
  access.helm.mockResolvedValue('[]');
  access.kubectl.mockResolvedValue('');
  const slept: number[] = [];
  const pool = new PoolNode({ access, node: NODE, sleep: async (ms) => { slept.push(ms); } });
  const kinds = () => access.apply.mock.calls.filter(([, , options]) => !options?.serverSide).map(([where, docs]) => [where, docs.split('\n---\n').map((doc) => (JSON.parse(doc) as { kind: string }).kind)]);
  return { access, pool, slept, kinds };
}

const kubectlAsked = (access: ReturnType<typeof node>['access']) => access.kubectl.mock.calls.map(([where, args]) => [where, args.join(' ')]);

describe('readying the pool\'s node', () => {
  const caddies = async () => ['100.64.0.1'];

  it('refuses a node without gVisor, applying nothing', async () => {
    const { access, pool } = node();
    access.kubectl.mockResolvedValueOnce('runtimeclass.node.k8s.io/runc\n');
    await expect(pool.ready({ image: IMAGE, address: '100.64.0.9' }, caddies)).rejects.toThrow('the pool\'s node has no gVisor runtime yet');
    expect(access.apply).not.toHaveBeenCalled();
  });

  it('puts the admission policy there and waits until it refuses a pod off gVisor, then starts the proxy and the monitoring it lacks, all on root\'s cluster', async () => {
    const { access, pool, slept, kinds } = node();
    let dryRuns = 0;
    access.kubectl.mockImplementation(async (_at, args) => {
      if (args[1] === 'runtimeclass') return 'runtimeclass.node.k8s.io/gvisor\n';
      if (args[0] === 'run') {
        dryRuns += 1;
        if (dryRuns === 1) throw new Error('the policy is not there yet');
        if (dryRuns === 2) return 'pod/admission-check';
        throw new Error('admission webhook denied: a pool pod runs under gVisor');
      }
      return '';
    });
    const values: string[] = [];
    access.helm.mockImplementation(async (_at, args) => {
      if (args[0] === 'list') return '[]';
      if (args[0] === 'show') return '';
      values.push(readFileSync(args[args.indexOf('-f') + 1]!, 'utf8'));
      return '';
    });
    await pool.ready({ image: IMAGE, address: '100.64.0.9' }, caddies);
    expect(slept).toEqual([2000, 2000]);
    expect(kinds()[0]![0]).toBe(NODE);
    expect(kinds()[0]![1]).toContain('Namespace');
    expect(kubectlAsked(access)).toContainEqual([NODE, `run admission-check -n ${ADMISSION_CHECK_NAMESPACE} --image=busybox:1.37 --restart=Never --dry-run=server -o name`]);
    expect(kubectlAsked(access)).toContainEqual([NODE, 'get daemonset pool-proxy -n kube-system --ignore-not-found -o name']);
    expect(kinds()[1]![1]).toContain('DaemonSet');
    expect(access.helm.mock.calls.filter(([, args]) => args[0] === 'upgrade').map(([where, args]) => [where, args[2]])).toEqual([[NODE, 'kube-prometheus-stack'], [NODE, 'blackbox-exporter']]);
    expect(values).toHaveLength(2);
    expect(kinds()[2]).toEqual([NODE, ['PrometheusRule']]);
    const valuesFile = access.helm.mock.calls.find(([, args]) => args[0] === 'upgrade')![1];
    expect(existsSync(valuesFile[valuesFile.indexOf('-f') + 1]!)).toBe(false);
  });

  it('leaves a proxy and monitoring that are already there, and asks root\'s mesh nothing', async () => {
    const { access, pool, kinds } = node();
    access.kubectl.mockImplementation(async (_at, args) => {
      if (args[1] === 'runtimeclass') return 'runtimeclass.node.k8s.io/gvisor\n';
      if (args[0] === 'run') throw new Error('runs under gVisor');
      if (args[1] === 'daemonset') return 'daemonset.apps/pool-proxy\n';
      return '';
    });
    access.helm.mockImplementation(async (_at, args) => JSON.stringify([{ chart: args[4] === '^kube-prometheus-stack$' ? 'kube-prometheus-stack-91.7.0' : 'prometheus-blackbox-exporter-11.19.1', status: 'deployed' }]));
    let asked = false;
    await pool.ready({ image: IMAGE, address: '100.64.0.9' }, async () => { asked = true; return []; });
    expect(asked).toBe(false);
    expect(access.helm.mock.calls.map(([, args]) => args[0])).toEqual(['list', 'list']);
    expect(kinds().map(([, docs]) => docs)).toEqual([expect.arrayContaining(['Namespace']), ['PrometheusRule']]);
  });

  it('applies the stack\'s CRDs server-side before upgrading it from another version, since Helm never upgrades CRDs', async () => {
    const { access, pool } = node();
    access.kubectl.mockImplementation(async (_at, args) => {
      if (args[1] === 'runtimeclass') return 'runtimeclass.node.k8s.io/gvisor\n';
      if (args[0] === 'run') throw new Error('runs under gVisor');
      return 'daemonset.apps/pool-proxy';
    });
    const order: string[] = [];
    access.helm.mockImplementation(async (_at, args) => {
      order.push(args.slice(0, 3).join(' '));
      if (args[0] === 'list') return JSON.stringify([{ chart: args[4] === '^kube-prometheus-stack$' ? 'kube-prometheus-stack-88.6.2' : 'prometheus-blackbox-exporter-11.19.1', status: 'deployed' }]);
      return args[0] === 'show' ? '# the stack\'s CRDs' : '';
    });
    access.apply.mockImplementation(async (_at, manifest, options) => { if (options?.serverSide) order.push(`server-side ${manifest}`); return ''; });
    await pool.ready({ image: IMAGE, address: '100.64.0.9' }, caddies);
    expect(order.slice(order.indexOf('show crds kube-prometheus-stack'))).toEqual(['show crds kube-prometheus-stack', 'server-side # the stack\'s CRDs', 'upgrade --install kube-prometheus-stack', 'list -n monitoring']);
  });

  it('installs a release that is there but not deployed again', async () => {
    const { access, pool } = node();
    access.kubectl.mockImplementation(async (_at, args) => {
      if (args[1] === 'runtimeclass') return 'runtimeclass.node.k8s.io/gvisor\n';
      if (args[0] === 'run') throw new Error('runs under gVisor');
      return 'daemonset.apps/pool-proxy';
    });
    access.helm.mockImplementation(async (_at, args) => (args[0] === 'list' ? JSON.stringify([{ chart: 'kube-prometheus-stack-91.7.0', status: 'failed' }]) : ''));
    await pool.ready({ image: IMAGE, address: '100.64.0.9' }, caddies);
    expect(access.helm.mock.calls.filter(([, args]) => args[0] === 'upgrade')).toHaveLength(2);
  });
});

describe('the pool\'s proxy', () => {
  it('has its Caddyfile applied on root\'s cluster', async () => {
    const { access, pool, kinds } = node();
    await pool.proxy(':80 {\n}\n');
    expect(kinds()).toEqual([[NODE, ['ConfigMap']]]);
    expect(access.apply.mock.calls[0]![1]).toContain(':80');
  });
});

describe('a trial\'s vcluster', () => {
  it('gets its namespace, its probe policy and its vcluster on root\'s cluster, then waits for its sign-in', async () => {
    const { access, pool, slept, kinds } = node();
    let asked = 0;
    access.kubectl.mockImplementation(async () => {
      asked += 1;
      if (asked === 1) throw new Error('secrets "vc-ann" not found');
      if (asked === 2) return '';
      return 'secret/vc-ann';
    });
    let written = '';
    access.helm.mockImplementation(async (_at, args) => { written = readFileSync(args[args.indexOf('-f') + 1]!, 'utf8'); return ''; });
    await pool.vcluster({ name: 'ann', ownerId: 'o1', registryPort: 30100 }, SLOT);
    expect(kinds().map(([where, docs]) => [where, docs])).toEqual([[NODE, ['Namespace', 'RoleBinding']], [NODE, ['NetworkPolicy']]]);
    expect(access.helm.mock.calls[0]).toEqual([NODE, expect.arrayContaining(['upgrade', '--install', 'ann', 'vcluster', '-n', 'pool-ann'])]);
    expect(JSON.parse(written)).toBeTruthy();
    expect(slept).toEqual([2000, 2000]);
    expect(kubectlAsked(access).at(-1)).toEqual([NODE, 'get secret vc-ann -n pool-ann -o name']);
  });
});

describe('installing Koala in a trial', () => {
  it('applies its values and the install job on root\'s cluster and returns once the job succeeded', async () => {
    const { access, pool, slept, kinds } = node();
    access.kubectl.mockResolvedValueOnce('|').mockRejectedValueOnce(new Error('the API answered nothing')).mockResolvedValueOnce('1|');
    await pool.install('ann', 'install-1', { a: 1 }, IMAGE);
    expect(kinds()).toEqual([[NODE, ['Secret', 'Job']]]);
    expect(slept).toEqual([5000, 5000]);
    expect(kubectlAsked(access).at(-1)).toEqual([NODE, 'get job install-1 -n pool-ann -o jsonpath={.status.succeeded}|{.status.failed}']);
  });

  it('fails with the end of the job\'s log when it failed, or why the log could not be read', async () => {
    const failed = node();
    failed.access.kubectl.mockResolvedValueOnce('|1').mockResolvedValueOnce('one\ntwo\nError: helm said no\n');
    await expect(failed.pool.install('ann', 'install-1', {}, IMAGE)).rejects.toThrow('installing Koala in pool-ann failed: one | two | Error: helm said no');
    const unread = node();
    unread.access.kubectl.mockResolvedValueOnce('|1').mockRejectedValueOnce(new Error('pods gone'));
    await expect(unread.pool.install('ann', 'install-1', {}, IMAGE)).rejects.toThrow('installing Koala in pool-ann failed: its log could not be read: pods gone');
    const silent = node();
    silent.access.kubectl.mockResolvedValueOnce('|1').mockResolvedValueOnce('  ');
    await expect(silent.pool.install('ann', 'install-1', {}, IMAGE)).rejects.toThrow('installing Koala in pool-ann failed: no log');
  });

  it('puts the chart from the image on the vcluster it was handed with the one install step, which follows it until all is up, tried once', () => {
    const job = installJob('install-1', 'pool-ann', 'ann', IMAGE) as { spec: { backoffLimit: number; template: { spec: { containers: Array<{ image: string; command: string[] }> } } } };
    const container = job.spec.template.spec.containers[0]!;
    expect(container.image).toBe('reg.test/nowrinkles/app:v1');
    expect(container.command[2]).toContain('exec entrypoint install-koala --kubeconfig /tmp/kubeconfig --release instance --namespace nowrinkles --chart /app/charts/instance -- -f /values/values.json');
    expect(container.command[2]).not.toMatch(/--wait|--timeout/);
    expect(job.spec.backoffLimit).toBe(0);
  });
});

describe('a trial\'s backend answering through the proxy', () => {
  it('is asked from the proxy on root\'s cluster until it answers', async () => {
    const { access, pool, slept } = node();
    access.kubectl.mockRejectedValueOnce(new Error('connection refused')).mockResolvedValueOnce('');
    await pool.backendAnswers('100.64.0.9', 30001, 'ann\'s backend');
    expect(slept).toEqual([5000]);
    expect(kubectlAsked(access)).toEqual([
      [NODE, 'exec -n kube-system daemonset/pool-proxy -- sh -c wget -q -O /dev/null -T 10 http://100.64.0.9:30001/api/auth/sign-in'],
      [NODE, 'exec -n kube-system daemonset/pool-proxy -- sh -c wget -q -O /dev/null -T 10 http://100.64.0.9:30001/api/auth/sign-in'],
    ]);
  });
});

describe('stopping, starting and removing a trial', () => {
  it('scales its vcluster down and removes its synced pods, or scales it up', async () => {
    const { access, pool } = node();
    await pool.replicas('ann', 0);
    await pool.replicas('ann', 1);
    expect(kubectlAsked(access)).toEqual([
      [NODE, 'scale statefulset ann -n pool-ann --replicas=0'],
      [NODE, 'delete pods -n pool-ann -l vcluster.loft.sh/managed-by=ann --wait=true'],
      [NODE, 'scale statefulset ann -n pool-ann --replicas=1'],
    ]);
  });

  it('uninstalls its vcluster and deletes its namespace on root\'s cluster', async () => {
    const { access, pool } = node();
    await pool.remove('ann');
    expect(access.helm).toHaveBeenCalledWith(NODE, ['uninstall', 'ann', '-n', 'pool-ann', '--ignore-not-found', '--wait', '--timeout', '720h']);
    expect(kubectlAsked(access)).toEqual([[NODE, 'delete namespace pool-ann --ignore-not-found --wait=true']]);
  });
});

describe('the manifests sent to the node', () => {
  it('are one YAML stream of JSON documents', () => {
    expect(yaml([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n---\n{"b":2}');
  });
});
