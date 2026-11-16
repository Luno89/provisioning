import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reopening, untilAnswered, type Reopening } from '@koala/engine-core/reopening';
import { abandonedJobs, UPGRADE_WORDS, withWhy, type ClusterStarts } from '../instances/index.js';
import { clusterAccessFrom, ROLLOUT_KINDS, rolloutOf, stuckHook } from '../infrastructure/index.js';
import { selfUpgradeSettingsFrom } from '../platform/index.js';

export interface SelfUpgradeCluster {
  kubectl(args: readonly string[]): Promise<string>;
  helm(args: readonly string[], signal?: AbortSignal): Promise<string>;
}

export function selfUpgradeClusterOn(access: Pick<ClusterStarts, 'kubectl' | 'own' | 'startHelm'>): SelfUpgradeCluster {
  return {
    kubectl: (args) => access.kubectl(access.own(), args),
    async helm(args, signal) {
      const started = await access.startHelm(access.own(), args);
      const stop = (): void => started.stop();
      if (signal?.aborted) stop();
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const result = await started.ended;
        if (result.code !== 0) throw new Error(`helm ${args[0] ?? ''} ended with ${result.code}: ${result.stderr.trim()}`);
        return result.stdout;
      } finally {
        signal?.removeEventListener('abort', stop);
      }
    },
  };
}

export interface SelfUpgradeDeps {
  root: { url: string; instanceId: string; credential: string };
  release: { name: string; namespace: string; current: string };
  cluster: SelfUpgradeCluster;
  fetch?: typeof fetch;
  wait?: Reopening;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

interface Released { imageTag: string; chartUrl: string; digest?: string; chartSha256?: string }

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CEILING = '720h';

export async function selfUpgrade(deps: SelfUpgradeDeps): Promise<boolean> {
  const call = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  const headers = { 'X-Instance-Id': deps.root.instanceId, Authorization: `Bearer ${deps.root.credential}` };
  const { name, namespace, current } = deps.release;
  const wait = deps.wait ?? reopening();
  const ofRoot = (doing: string, ask: () => Promise<Response>): Promise<Response> =>
    untilAnswered(ask, wait, (why, seconds) => log(`root isn't answering when this instance ${doing} (${why}); asking again in ${seconds} s`));

  const report = async (status: string, detail: string, imageTag?: string): Promise<void> => {
    const answer = await ofRoot(`tells it it is ${status}`, () => call(`${deps.root.url}/api/instances/status`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, detail, ...(imageTag ? { imageTag } : {}), presence: true }),
    }));
    if (!answer.ok) log(`root refused hearing that this instance is ${status} (${answer.status}): ${await answer.text()}`);
  };

  const asked = await ofRoot('asks which release to run', () => call(`${deps.root.url}/api/instances/release`, { headers }));
  if (!asked.ok) throw new Error(`root did not say which release this instance should run (${asked.status}): ${await asked.text()}`);
  const wanted = await asked.json() as Released;
  if (wanted.imageTag === current) {
    await report('ready', UPGRADE_WORDS.running(current), current);
    return true;
  }

  await report('installing', UPGRADE_WORDS.upgrading(current, wanted.imageTag));
  const chart = await ofRoot(`downloads the chart for ${wanted.imageTag}`, () => call(wanted.chartUrl));
  if (!chart.ok) throw new Error(`root's chart for ${wanted.imageTag} could not be downloaded (${chart.status})`);
  const bytes = Buffer.from(await chart.arrayBuffer());
  if (wanted.chartSha256 && createHash('sha256').update(bytes).digest('hex') !== wanted.chartSha256) {
    await report('failed', UPGRADE_WORDS.wrongChart(wanted.imageTag));
    return false;
  }
  if (wanted.digest && !DIGEST.test(wanted.digest)) {
    await report('failed', UPGRADE_WORDS.notADigest(wanted.digest, wanted.imageTag));
    return false;
  }

  const dir = await mkdtemp(join(tmpdir(), 'self-upgrade-'));
  try {
    const chartFile = join(dir, 'chart.tgz');
    await writeFile(chartFile, bytes);
    const since = now();
    const applied = await whileHelmRuns(['upgrade', name, chartFile, '-n', namespace, '--reset-then-reuse-values', '--set', `image.tag=${wanted.imageTag}`, '--set-string', `image.digest=${wanted.digest ?? ''}`, '--timeout', CEILING], since);
    const upgraded = applied.ok ? await rollout() : { state: 'hopeless' as const, reason: applied.reason };
    if (upgraded.state === 'done') {
      await report('ready', UPGRADE_WORDS.upgraded(wanted.imageTag), wanted.imageTag);
      return true;
    }
    log(`the upgrade to ${wanted.imageTag} cannot finish: ${upgraded.reason}; rolling back to ${current}`);
    const back = await deps.cluster.helm(['rollback', name, '-n', namespace, '--timeout', CEILING])
      .then(() => rollout(), (err: Error) => ({ state: 'hopeless' as const, reason: err.message }));
    const left = await clearAbandoned(since);
    const why = left ? `${upgraded.reason}; ${left}` : upgraded.reason;
    await report('failed', back.state === 'done'
      ? withWhy(UPGRADE_WORDS.rolledBack(wanted.imageTag, current), why)
      : withWhy(UPGRADE_WORDS.notRolledBack(wanted.imageTag, current), `${why}; rolling back: ${back.reason}`));
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  async function whileHelmRuns(args: string[], since: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const stop = new AbortController();
    const ended: { result?: { ok: true } | { ok: false; reason: string } } = {};
    const helm = deps.cluster.helm(args, stop.signal).then(() => { ended.result = { ok: true }; }, (err: Error) => { ended.result = { ok: false, reason: err.message }; });
    for (;;) {
      await Promise.race([helm, sleep(5000)]);
      if (ended.result) return ended.result;
      const stuck = stuckHook(JSON.parse(await deps.cluster.kubectl(['get', 'jobs,pods', '-n', namespace, '-l', `app.kubernetes.io/instance=${name}`, '-o', 'json'])), since, now());
      if (stuck) {
        stop.abort();
        await helm;
        return { ok: false, reason: stuck };
      }
    }
  }

  async function clearAbandoned(since: number): Promise<string | undefined> {
    try {
      const names = abandonedJobs(JSON.parse(await deps.cluster.kubectl(['get', 'jobs', '-n', namespace, '-l', `app.kubernetes.io/instance=${name}`, '-o', 'json'])), since);
      if (names.length > 0) await deps.cluster.kubectl(['delete', 'jobs', '-n', namespace, '--ignore-not-found', ...names]);
      return undefined;
    } catch (err) {
      const said = `the jobs the upgrade left could not be removed, and one still running stops the next check-in: ${(err as Error).message}`;
      log(said);
      return said;
    }
  }

  async function rollout(): Promise<{ state: 'done' } | { state: 'hopeless'; reason: string }> {
    let said = '';
    for (;;) {
      const listed: unknown = JSON.parse(await deps.cluster.kubectl(['get', ROLLOUT_KINDS, '-n', namespace, '-l', `app.kubernetes.io/instance=${name}`, '-o', 'json']));
      const now = rolloutOf(listed);
      if (now.state !== 'rolling') return now;
      if (now.waiting !== said) log(`waiting: ${now.waiting}`);
      said = now.waiting;
      await sleep(5000);
    }
  }
}

if (process.argv[1]?.endsWith('self-upgrade.ts')) {
  const settings = selfUpgradeSettingsFrom(process.env);
  selfUpgrade({
    root: settings.root,
    release: settings.release,
    cluster: selfUpgradeClusterOn(clusterAccessFrom(settings.clusters, { role: settings.role.role })),
  }).then((ok) => { process.exitCode = ok ? 0 : 1; }, (err: Error) => { console.error(err.message); process.exitCode = 1; });
}
