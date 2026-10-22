import { describe, it, expect } from 'vitest';
import { CancelledFailure } from '@temporalio/common';
import { createCheckReleases, createReleaseBrowserTestActivities, type ReleaseBrowserTestsInput, type SpecSource } from './ReleaseBrowserTestsActivity.js';
import type { NamespacedCluster } from './cluster-jobs.js';
import { PLAYWRIGHT_REPORT } from '../engine/lib/e2e-fixtures.js';

const PASSING = JSON.stringify({ suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'signs in', file: 'a.spec.ts', tests: [{ status: 'expected', results: [{ duration: 900 }] }] }] }], errors: [] });
const SHOT = Buffer.alloc(50_000, 7);

const input: ReleaseBrowserTestsInput = {
  target: { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' },
  source: { owner: 'bo', repo: 'shop', commit: 'abcdef1234' },
  ownerId: 'bo',
  releaseId: 'r2',
  slot: 'b',
  image: 'reg/bo/shop:two',
};

function repo(files: Record<string, string>): SpecSource {
  return {
    listPaths: async () => Object.keys(files),
    getRawFile: async (_owner, _name, path) => files[path] ?? null,
  };
}

function cluster(options: { done?: string; report?: string; files?: Record<string, Buffer>; secret?: boolean; podPhase?: string; loginFails?: boolean; vault?: boolean } = {}) {
  const applied: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const files: Record<string, Buffer> = {
    ...(options.report !== undefined ? { 'e2e-results/report.json': Buffer.from(options.report) } : {}),
    'run.log': Buffer.from('  1 passed (4.2s)\n'),
    'npm.log': Buffer.from('npm ERR! network request to https://registry.npmjs.org failed\n'),
    ...(options.files ?? {}),
  };
  const run = (command: string): string => {
    if (command === 'cat done 2>/dev/null') return options.done ?? '';
    const size = /^wc -c < (.+)$/.exec(command);
    if (size) {
      const file = files[size[1]!];
      if (!file) throw new Error('No such file');
      return `${file.length}\n`;
    }
    const piece = /^tail -c \+(\d+) '(.+)' \| head -c (\d+) \| base64 -w0$/.exec(command);
    if (piece) return files[piece[2]!]!.subarray(Number(piece[1]) - 1, Number(piece[1]) - 1 + Number(piece[3])).toString('base64');
    const tail = /^tail -n \d+ (.+)$/.exec(command);
    if (tail) return files[tail[1]!]?.toString() ?? '';
    if (command.startsWith('find e2e-results/artifacts')) {
      return Object.entries(files).filter(([path]) => path.startsWith('e2e-results/artifacts/')).map(([path, bytes]) => `${bytes.length} ${path}`).join('\n');
    }
    throw new Error(`unexpected command ${command}`);
  };
  const io: NamespacedCluster = {
    async kubectl(args) {
      calls.push(args.slice(0, 3).join(' '));
      if (args[0] === 'get' && args[1] === 'secret' && args[2] === 'shop-vault') return options.vault ? JSON.stringify({ POSTGRES_PASSWORD: 'eA==' }) : '';
      if (args[0] === 'get' && args[1] === 'secret') {
        if (options.secret) return 'secret/shop-e2e-login';
        throw new Error('Error from server (NotFound): secrets "shop-e2e-login" not found');
      }
      if (args[0] === 'get' && args[1] === 'job') return options.loginFails ? '|1' : '1|';
      if (args[0] === 'logs') return 'Traceback (most recent call last):\nKeyError: base.user_admin';
      if (args[0] === 'get' && args[1] === 'pod') return JSON.stringify({ items: [{ metadata: { name: 'shop-e2e-x1' }, status: { phase: options.podPhase ?? 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: {} }] } }] });
      if (args[0] === 'exec') return run(args.at(-1)!.replace(/^cd \/work && /, ''));
      return '';
    },
    async apply(manifest) { applied.push(manifest); },
  };
  return { io, applied, calls };
}

const kept: { ownerId: string; runId: string; names: string[]; sizes: number[] }[] = [];
const activity = (made: ReturnType<typeof cluster>, files: Record<string, string>, cancelled = () => false) => createReleaseBrowserTestActivities({
  cluster: () => made.io,
  specs: async () => repo(files),
  keep: async (ownerId, runId, given) => {
    kept.push({ ownerId, runId, names: given.map((file) => file.name), sizes: given.map((file) => file.bytes.length) });
    return { stored: given.map((file, n) => ({ id: `a${n}`, name: file.name })), dropped: [], minioMissing: true };
  },
  password: () => 'pw-from-test',
  now: () => 't',
  pollMs: 1,
  beat: () => undefined,
  cancelled,
}).ReleaseBrowserTestsActivity;

const SPECS = { 'e2e/signs-in.spec.ts': 'test()', 'playwright.config.ts': 'config' };

describe('running a release\'s browser tests against its preview', () => {
  it('sets up the test login, runs the project\'s specs at the build\'s commit, and reads the report back', async () => {
    const made = cluster({ done: '0', report: PASSING });
    const result = await activity(made, SPECS)(input);
    expect(result).toMatchObject({ state: 'passed', summary: '1 passed, 0 failed', tests: [{ title: 'signs in', status: 'passed' }] });
    expect(made.applied.map((manifest) => `${manifest.kind} ${(manifest.metadata as { name: string }).name}`)).toEqual(['Secret shop-e2e-login', 'Job shop-e2e-login-b', 'ConfigMap shop-e2e', 'Job shop-e2e']);
    expect(made.applied[0]).toMatchObject({ stringData: { password: 'pw-from-test' } });
    expect(made.applied[2]).toMatchObject({ data: { f0: 'config', f1: 'test()' } });
    expect(made.calls.slice(-2)).toEqual(['delete job shop-e2e', 'delete configmap shop-e2e']);
  });

  it('keeps the login it already made', async () => {
    const made = cluster({ done: '0', report: PASSING, secret: true });
    await activity(made, SPECS)(input);
    expect(made.applied.map((manifest) => manifest.kind)).toEqual(['Job', 'ConfigMap', 'Job']);
  });

  it('signs the test login in to the database with the vault\'s password once the vault holds one, and the chart\'s own otherwise', async () => {
    const passwordOf = (made: ReturnType<typeof cluster>) => ((made.applied[0] as { spec: { template: { spec: { containers: { env: { name: string; valueFrom?: { secretKeyRef: unknown } }[] }[] } } } })
      .spec.template.spec.containers[0]!.env.find((entry) => entry.name === 'PASSWORD')!.valueFrom!.secretKeyRef);
    const vaulted = cluster({ done: '0', report: PASSING, secret: true, vault: true });
    await activity(vaulted, SPECS)(input);
    expect(passwordOf(vaulted)).toEqual({ name: 'shop-vault', key: 'POSTGRES_PASSWORD' });
    const older = cluster({ done: '0', report: PASSING, secret: true });
    await activity(older, SPECS)(input);
    expect(passwordOf(older)).toEqual({ name: 'shop-secrets', key: 'postgres-password' });
  });

  it('keeps what the browser saw when a test fails, under the release, read back whole', async () => {
    kept.length = 0;
    const made = cluster({ done: '1', report: PLAYWRIGHT_REPORT, files: { 'e2e-results/artifacts/sees-the-field/test-failed-1.png': SHOT } });
    const result = await activity(made, SPECS)(input);
    expect(result).toMatchObject({ state: 'failed', summary: '1 passed, 1 failed, 1 flaky, 1 skipped', artifacts: [{ id: 'a0', name: 'sees-the-field/test-failed-1.png' }] });
    expect(result.tests?.find((test) => test.status === 'failed')?.error).toContain('toBeVisible() failed');
    expect(kept).toEqual([{ ownerId: 'bo', runId: 'r2', names: ['sees-the-field/test-failed-1.png'], sizes: [SHOT.length] }]);
  });

  it('says there is nothing to run when the commit has no spec, without touching the cluster', async () => {
    const made = cluster();
    expect(await activity(made, { 'e2e/helpers.ts': 'x' })(input)).toEqual({ state: 'unavailable', reason: 'there are no browser tests in e2e/ at abcdef12', startedAt: 't', finishedAt: 't' });
    expect(made.calls).toEqual([]);
  });

  it('says why when the test login cannot be set up, or Playwright cannot be installed, or the pod dies', async () => {
    expect(await activity(cluster({ loginFails: true }), SPECS)(input)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('the test login could not be set up in slot b: shop-e2e-login-b failed:\nTraceback') });
    expect(await activity(cluster({ done: 'install' }), SPECS)(input)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('Playwright could not be installed in the browser\'s pod:\nnpm ERR! network request') });
    expect(await activity(cluster({ podPhase: 'Failed' }), SPECS)(input)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('the browser\'s pod ended before the tests finished') });
  });

  it('fails a run that left no report, quoting what Playwright printed', async () => {
    expect(await activity(cluster({ done: '1' }), SPECS)(input)).toMatchObject({ state: 'failed', reason: 'the browser tests left no report:\n1 passed (4.2s)' });
  });

  it('stops when the workflow stops it, and still clears the job away', async () => {
    const made = cluster({ done: '' });
    let polls = 0;
    await expect(activity(made, SPECS, () => (polls += 1) > 3)(input)).rejects.toBeInstanceOf(CancelledFailure);
    expect(made.calls.slice(-2)).toEqual(['delete job shop-e2e', 'delete configmap shop-e2e']);
  });
});

describe('reaching the release\'s namespace', () => {
  it('lets the namespace pull Koala-built images once, then puts everything it applies into the release\'s namespace, whatever the manifest says', async () => {
    const { namespacedCluster } = await import('./ReleaseBrowserTestsActivity.js');
    const applied: string[] = [];
    const infra = { applyManifest: async (manifest: string) => { applied.push(manifest); return ''; }, runKubectl: async () => '' };
    const target = { clusterName: 'box', provider: 'remote', namespace: 'shop', release: 'shop', kubeconfigPath: '/tmp/kubeconfig-box' };
    const login = { hosts: { push: 'gitea:3000', pull: 'gitea:3000' }, username: 'provisioning-bot', password: 'tok' };
    const reach = namespacedCluster(infra as never, async () => login)(target);
    await reach.apply({ kind: 'Secret', metadata: { name: 'shop-e2e-login' } });
    await reach.apply({ kind: 'Job', metadata: { name: 'shop-e2e' } });
    expect(JSON.parse(applied[0]!)).toMatchObject({ kind: 'List', items: [
      { kind: 'Secret', type: 'kubernetes.io/dockerconfigjson', metadata: { name: 'koala-registry-pull', namespace: 'shop' } },
      { kind: 'ServiceAccount', metadata: { name: 'default', namespace: 'shop' }, imagePullSecrets: [{ name: 'koala-registry-pull' }] },
    ] });
    expect(JSON.parse(applied[1]!)).toEqual({ kind: 'Secret', metadata: { name: 'shop-e2e-login', namespace: 'shop' } });
    expect(JSON.parse(applied[2]!)).toEqual({ kind: 'Job', metadata: { name: 'shop-e2e', namespace: 'shop' } });
    expect(applied).toHaveLength(3);
  });
});

describe('a check browsing its project\'s release', () => {
  const project = { id: 'p1', name: 'shop', ownerId: 'space-1', targetClusterId: 'c1', giteaOwner: 'space', giteaRepo: 'shop' };
  const made = (repoFiles: Record<string, string>) => {
    const runs: unknown[] = [];
    const io = cluster();
    const releases = createCheckReleases({
      browser: {
        readSpecs: createReleaseBrowserTestActivities({ cluster: () => io.io, specs: async () => repo(repoFiles) }).readSpecs,
        runBrowserTests: async (run) => { runs.push(run); return { state: 'passed', startedAt: 't' }; },
      },
      cluster: () => ({ ...io.io, kubectl: async (args) => (args[0] === 'get' && args[1] === 'namespace' ? '' : io.io.kubectl(args)) }),
      project: async (id) => (id === 'p1' ? project : undefined),
      clusterById: async () => ({ id: 'c1', name: 'provisioning-lunorica', provider: 'k3d' }) as never,
    });
    return { releases, runs };
  };
  const release = { slot: 'a' as const, image: 'reg/shop:2', commit: 'abcdef1234' };

  it('runs the check\'s own specs, with the scaffold\'s config, against the slot it names, keeping files under the check\'s run', async () => {
    const { releases, runs } = made({});
    await releases.browse({ ownerId: 'space-1', projectId: 'p1', release, specs: { 'e2e/live.spec.ts': 'test()' }, keepUnder: 'run-1' });
    expect(runs).toEqual([expect.objectContaining({
      target: { clusterName: 'provisioning-lunorica', provider: 'k3d', namespace: 'shop', release: 'shop', owner: { ownerId: 'space-1', projectId: 'p1' } },
      ownerId: 'space-1', keepUnder: 'run-1', slot: 'a', image: 'reg/shop:2',
      files: [expect.objectContaining({ path: 'playwright.config.ts' }), { path: 'e2e/live.spec.ts', content: 'test()' }],
    })]);
  });

  it('runs the project\'s own e2e/ at the release\'s commit when the check gives none, and says when there are none', async () => {
    const withSpecs = made(SPECS);
    await withSpecs.releases.browse({ ownerId: 'space-1', projectId: 'p1', release, keepUnder: 'run-1' });
    expect((withSpecs.runs[0] as { files: unknown[] }).files).toEqual([{ path: 'playwright.config.ts', content: 'config' }, { path: 'e2e/signs-in.spec.ts', content: 'test()' }]);
    expect(await made({}).releases.browse({ ownerId: 'space-1', projectId: 'p1', release, keepUnder: 'run-1' })).toMatchObject({ state: 'unavailable', reason: 'there are no browser tests in e2e/ at abcdef12' });
  });

  it('reaches only a project of the space\'s own, and sees when its namespace is gone', async () => {
    const { releases } = made({});
    await expect(releases.browse({ ownerId: 'someone-else', projectId: 'p1', release, keepUnder: 'run-1' })).rejects.toThrow('the check has no such project');
    expect(await releases.namespaceExists({ ownerId: 'space-1', projectId: 'p1' })).toBe(false);
  });

  it('looks where it last saw the app once the project is gone', async () => {
    const asked: { namespace: string; args: string[] }[] = [];
    const releases = createCheckReleases({
      browser: { readSpecs: async () => ({ files: [] }), runBrowserTests: async () => ({ state: 'passed', startedAt: 't' }) },
      cluster: (target) => ({ kubectl: async (args) => { asked.push({ namespace: target.namespace, args }); return 'namespace/shop-1a2b3c'; }, apply: async () => undefined }),
      project: async () => undefined,
      clusterById: async () => ({ id: 'c1', name: 'provisioning-lunorica', provider: 'k3d' }) as never,
    });
    expect(await releases.namespaceExists({ ownerId: 'space-1', projectId: 'gone', at: { clusterId: 'c1', namespace: 'shop-1a2b3c' } })).toBe(true);
    expect(asked).toEqual([{ namespace: 'shop-1a2b3c', args: ['get', 'namespace', 'shop-1a2b3c', '-o', 'name', '--ignore-not-found'] }]);
  });
});
