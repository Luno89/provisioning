import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reopening, untilAnswered, type Reopening } from '@koala/engine-core/reopening';
import { chartInputs, chartStep, followRelease, runSteps, StepFailed, type ChartCluster, type ChartRelease, type Progress, type Reporter, type WaitOptions } from '@koala/provision';
import { UPGRADE_WORDS, withWhy } from '../instances/index.js';
import { clusterAccessFrom } from '../infrastructure/index.js';
import { selfUpgradeSettingsFrom } from '../platform/index.js';

export interface SelfUpgradeDeps {
  root: { url: string; instanceId: string; credential: string };
  release: { name: string; namespace: string; current: string; dataVersion: number };
  cluster: ChartCluster;
  fetch?: typeof fetch;
  wait?: Reopening;
  watch?: WaitOptions;
  log?: (line: string) => void;
}

interface Released { imageTag: string; chartUrl: string; digest?: string; chartSha256?: string; dataVersion?: number }

type Ended = { state: 'done' } | { state: 'hopeless'; reason: string };

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const logged = (log: (line: string) => void): Reporter => ({
  started: () => undefined,
  alreadyDone: () => undefined,
  line: (_step, text) => log(text),
  done: () => undefined,
  failed: () => undefined,
});

export async function selfUpgrade(deps: SelfUpgradeDeps): Promise<boolean> {
  const call = deps.fetch ?? fetch;
  const log = deps.log ?? ((line: string) => console.log(line));
  const headers = { 'X-Instance-Id': deps.root.instanceId, Authorization: `Bearer ${deps.root.credential}` };
  const { name, namespace, current, dataVersion: installed } = deps.release;
  const wait = deps.wait ?? reopening();
  const ctx = { cluster: deps.cluster, ...(deps.watch ? { wait: deps.watch } : {}) };
  const progress: Progress = { line: log };
  const ofRoot = (doing: string, ask: () => Promise<Response>): Promise<Response> =>
    untilAnswered(ask, wait, (why, seconds) => log(`root isn't answering when this instance ${doing} (${why}); asking again in ${seconds} s`));

  const report = async (status: string, detail: string, imageTag?: string, dataVersion = installed): Promise<void> => {
    const answer = await ofRoot(`tells it it is ${status}`, () => call(`${deps.root.url}/api/instances/status`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, detail, ...(imageTag ? { imageTag } : {}), dataVersion, presence: true }),
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
  const wantedData = wanted.dataVersion ?? 0;
  if (wantedData < installed) {
    await report('failed', UPGRADE_WORDS.belowData(wanted.imageTag, installed));
    return false;
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
    const release: ChartRelease = {
      release: name,
      namespace,
      chart: chartFile,
      values: ['--reset-then-reuse-values', '--set', `image.tag=${wanted.imageTag}`, '--set-string', `image.digest=${wanted.digest ?? ''}`],
      inputs: chartInputs([bytes, wanted.imageTag, wanted.digest ?? '']),
    };
    const upgraded = await runSteps([chartStep({ id: 'upgrade', title: UPGRADE_WORDS.upgrading(current, wanted.imageTag) }, release)], ctx, logged(log)).then(
      (): Ended => ({ state: 'done' }),
      (err: unknown): Ended => {
        if (err instanceof StepFailed) return { state: 'hopeless', reason: err.why };
        throw err;
      },
    );
    if (upgraded.state === 'done') {
      await report('ready', UPGRADE_WORDS.upgraded(wanted.imageTag), wanted.imageTag, wantedData);
      return true;
    }
    if (wantedData > installed) {
      log(`the upgrade to ${wanted.imageTag} cannot finish: ${upgraded.reason}; it is not rolled back to ${current}, which cannot run the data it may have moved forward`);
      await report('failed', withWhy(UPGRADE_WORDS.keptForData(wanted.imageTag, current, wantedData), upgraded.reason), undefined, wantedData);
      return false;
    }
    log(`the upgrade to ${wanted.imageTag} cannot finish: ${upgraded.reason}; rolling back to ${current}`);
    const back = await deps.cluster.helm(['rollback', name, '-n', namespace])
      .then(() => followRelease(ctx, release, `the rollback to ${current}`, progress))
      .then((): Ended => ({ state: 'done' }), (err: Error): Ended => ({ state: 'hopeless', reason: err.message }));
    await report('failed', back.state === 'done'
      ? withWhy(UPGRADE_WORDS.rolledBack(wanted.imageTag, current), upgraded.reason)
      : withWhy(UPGRADE_WORDS.notRolledBack(wanted.imageTag, current), `${upgraded.reason}; rolling back: ${back.reason}`));
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('self-upgrade.ts')) {
  const settings = selfUpgradeSettingsFrom(process.env);
  const access = clusterAccessFrom(settings.clusters, { role: settings.role.role });
  selfUpgrade({
    root: settings.root,
    release: settings.release,
    cluster: access.chartCluster(access.own()),
  }).then((ok) => { process.exitCode = ok ? 0 : 1; }, (err: Error) => { console.error(err.message); process.exitCode = 1; });
}
