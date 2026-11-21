import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { KOALA_INSTALL_LAST_STAGE, koalaInstallProgressPath, koalaStopOf, type PlacedKoala } from '@koala/engine-core/koala-install';
import { allReporters, chartInputs, chartStep, runSteps, StepFailed, type ChartRelease, type ChartContext, type Reporter, type StepName, type Step, type WaitOptions } from '@koala/provision';
import { clusterState, machineChartCluster, runMachineCluster, stoppableHost, stoppedPause, type ClusterHost } from './machine-cluster.js';
import { rootProgress, rootReporter, rootUrlOf } from './root-progress.js';

export type { PlacedKoala };

export const KOALA_NAMESPACE = 'nowrinkles';
export const KOALA_RELEASE = 'instance';
export const BACKEND_NODE_PORT = 30320;
export const EDGE_NODE_PORT = 30321;

const TEXT_FIELDS = ['installId', 'instanceId', 'ownerId', 'machineId', 'rootUrl', 'rootPublicKeys', 'meshLoginServer', 'meshAddress', 'image', 'imageTag', 'chartUrl', 'registrationCode'] as const;

export function placedFrom(raw: unknown): PlacedKoala | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (!TEXT_FIELDS.every((field) => typeof record[field] === 'string' && record[field])) return undefined;
  const optional = (field: string) => (typeof record[field] === 'string' && record[field] ? record[field] : undefined);
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, record[field]])),
    imageDigest: optional('imageDigest'),
    chartSha256: optional('chartSha256'),
    name: typeof record.name === 'string' ? record.name : '',
    domain: typeof record.domain === 'string' ? record.domain : '',
  } as PlacedKoala;
}

export const koalaUrlOf = (placed: Pick<PlacedKoala, 'domain' | 'name' | 'meshAddress'>): string =>
  (placed.domain && placed.name ? `https://${placed.name}.${placed.domain}` : `http://${placed.meshAddress}:${BACKEND_NODE_PORT}`);

export const MACHINE_STORES_SIZE = '100Gi';

export function koalaValues(placed: PlacedKoala): Record<string, unknown> {
  const routed = Boolean(placed.domain && placed.name);
  return {
    image: { repository: placed.image, tag: placed.imageTag, ...(placed.imageDigest ? { digest: placed.imageDigest } : {}) },
    instance: { id: placed.instanceId, ownerId: placed.ownerId, rootUrl: placed.rootUrl, registrationCode: placed.registrationCode, machineId: placed.machineId },
    publicUrl: koalaUrlOf(placed),
    backend: { nodePort: BACKEND_NODE_PORT },
    mesh: { loginServer: placed.meshLoginServer, address: placed.meshAddress },
    storage: { total: MACHINE_STORES_SIZE },
    ...(routed ? { routing: { name: placed.name, domain: placed.domain }, edge: { nodePort: EDGE_NODE_PORT } } : {}),
  };
}

export const ownValuesFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'koala', 'koala-values.yaml');

export function ownPublicUrl(ownValuesYaml: string): string | undefined {
  const parsed: unknown = parse(ownValuesYaml);
  const value = parsed && typeof parsed === 'object' ? (parsed as { publicUrl?: unknown }).publicUrl : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

export interface InstallContext {
  placed: PlacedKoala;
  host: ClusterHost;
  helm: string;
  fetch: typeof fetch;
  work: string;
  own?: { file: string; yaml: string } | undefined;
  chart?: Buffer | undefined;
  wait?: WaitOptions | undefined;
}

const chartFile = (ctx: InstallContext): string => path.join(ctx.work, 'instance-chart.tgz');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const startCluster: Step<InstallContext> = {
  id: 'cluster',
  title: 'Starting this machine\'s cluster',
  check: async (ctx) => (await clusterState(ctx.host) === 'running' ? { done: true } : { done: false, why: 'k3s is not running on this machine' }),
  apply: async (ctx, progress) => {
    await runMachineCluster(ctx.host, { kind: 'start' });
    progress.line('k3s answers on this machine');
  },
};

const fetchChart: Step<InstallContext> = {
  id: 'chart',
  title: 'Fetching Koala\'s chart from root',
  check: async (ctx) => {
    if (!ctx.chart) return { done: false, why: 'the chart has not been fetched in this install' };
    if (ctx.placed.chartSha256 && sha256(ctx.chart) !== ctx.placed.chartSha256) return { done: false, why: 'the chart root sent is not the one it released (its sha256 differs); nothing was installed' };
    return { done: true };
  },
  apply: async (ctx) => {
    const answer = await ctx.fetch(ctx.placed.chartUrl);
    if (!answer.ok) throw new Error(`root's chart answered ${answer.status}`);
    ctx.chart = Buffer.from(await answer.arrayBuffer());
    await writeFile(chartFile(ctx), ctx.chart);
  },
};

async function releaseOf(ctx: InstallContext): Promise<ChartRelease> {
  if (!ctx.chart) throw new Error('Koala\'s chart was not fetched before it was applied');
  const values = path.join(ctx.work, 'koala-values.json');
  const keys = path.join(ctx.work, 'root-keys.pem');
  const rootValues = JSON.stringify(koalaValues(ctx.placed));
  await writeFile(values, rootValues, { mode: 0o600 });
  await writeFile(keys, ctx.placed.rootPublicKeys, { mode: 0o600 });
  return {
    release: KOALA_RELEASE,
    namespace: KOALA_NAMESPACE,
    chart: chartFile(ctx),
    values: ['-f', values, ...(ctx.own ? ['-f', ctx.own.file] : []), '--set-file', `instance.rootPublicKeys=${keys}`],
    inputs: chartInputs([ctx.chart, rootValues, ctx.own?.yaml ?? '', ctx.placed.rootPublicKeys]),
  };
}

const chartContext = (ctx: InstallContext): ChartContext => ({ cluster: machineChartCluster(ctx.host, ctx.helm), ...(ctx.wait ? { wait: ctx.wait } : {}) });

const KOALA_STEP = { id: KOALA_INSTALL_LAST_STAGE, title: 'Putting Koala on this machine' };

const putKoala: Step<InstallContext> = {
  ...KOALA_STEP,
  check: async (ctx) => chartStep(KOALA_STEP, await releaseOf(ctx)).check(chartContext(ctx)),
  apply: async (ctx, progress) => chartStep(KOALA_STEP, await releaseOf(ctx)).apply(chartContext(ctx), progress),
};

export const KOALA_INSTALL_STEPS: readonly Step<InstallContext>[] = [startCluster, fetchChart, putKoala];

export interface KoalaInstallDeps {
  cluster: ClusterHost;
  helm: string;
  fetch: typeof fetch;
  token: () => string;
  say: (line: string) => void;
  ownValues?: string | undefined;
  wait?: WaitOptions | undefined;
}

const saying = (say: (line: string) => void): Reporter => ({
  started: (step) => say(`${step.title}…`),
  alreadyDone: (step) => say(`${step.title}: already so`),
  line: (_step, text) => say(`  ${text}`),
  done: (step) => say(`${step.title}: done`),
  failed: (step, failure) => say(`${step.title} failed: ${failure.why}`),
});

const stoppableFetch = (fetcher: typeof fetch, stop: AbortSignal): typeof fetch => async (input, init) => {
  stop.throwIfAborted();
  return fetcher(input, { ...init, signal: stop });
};

function quietOnceStopped(reporter: Reporter, stop: AbortSignal): Reporter {
  return {
    started: (step: StepName) => (stop.aborted ? undefined : reporter.started(step)),
    alreadyDone: (step: StepName) => (stop.aborted ? undefined : reporter.alreadyDone(step)),
    line: (step, text) => { if (!stop.aborted) reporter.line(step, text); },
    done: (step: StepName) => (stop.aborted ? undefined : reporter.done(step)),
    failed: (step: StepName, failure: StepFailed) => (stop.aborted ? undefined : reporter.failed(step, failure)),
  };
}

function notesReady(host: ClusterHost, placed: PlacedKoala): Reporter {
  const note = async (step: StepName): Promise<void> => {
    if (step.id !== KOALA_INSTALL_LAST_STAGE) return;
    const held = await host.heldKoala();
    if (held?.installId !== placed.installId || held.readyAt) return;
    await host.holdKoala(placed.instanceId, placed.installId, new Date(host.now()).toISOString());
  };
  return { started: () => undefined, alreadyDone: note, line: () => undefined, done: note, failed: () => undefined };
}

const STOPPED_LINE = 'Putting Koala on this machine stopped: root stopped it before it finished';

export async function installKoala(placed: PlacedKoala, deps: KoalaInstallDeps, stop: AbortSignal = new AbortController().signal): Promise<void> {
  if (stop.aborted) {
    deps.say(STOPPED_LINE);
    return;
  }
  const own = deps.ownValues && await deps.cluster.exists(deps.ownValues) ? { file: deps.ownValues, yaml: await deps.cluster.read(deps.ownValues) } : undefined;
  const url = (own ? ownPublicUrl(own.yaml) : undefined) ?? koalaUrlOf(placed);
  const host = stoppableHost(deps.cluster, stop);
  const fetcher = stoppableFetch(deps.fetch, stop);
  const wait: WaitOptions = { ...deps.wait, pause: stoppedPause(deps.wait?.pause ?? ((ms) => deps.cluster.pause(ms)), stop) };
  const root = rootReporter(
    rootProgress(rootUrlOf(placed.rootUrl, koalaInstallProgressPath(placed.installId)), deps.token, fetcher, wait),
    { lines: true, ending: { stage: KOALA_INSTALL_LAST_STAGE, url } },
  );
  const work = await mkdtemp(path.join(os.tmpdir(), 'koala-install-'));
  try {
    if ((await deps.cluster.heldKoala())?.installId !== placed.installId) await deps.cluster.holdKoala(placed.instanceId, placed.installId);
    if (own) deps.say(`Koala takes this machine's own values from ${own.file}`);
    await runSteps(KOALA_INSTALL_STEPS, { placed, host, helm: deps.helm, fetch: fetcher, work, own, wait }, quietOnceStopped(allReporters(saying(deps.say), notesReady(deps.cluster, placed), root), stop));
    deps.say(`Koala runs on this machine at ${url}`);
  } catch (err) {
    if (stop.aborted) deps.say(STOPPED_LINE);
    else if (!(err instanceof StepFailed)) deps.say(`Koala could not be put on this machine: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface KoalaPlacements {
  place(raw: unknown): boolean;
  stop(raw: unknown): Promise<void>;
}

interface Running {
  instanceId: string;
  stop: AbortController;
  runs: number;
}

export function koalaPlacements(deps: KoalaInstallDeps): KoalaPlacements {
  let chain: Promise<void> = Promise.resolve();
  const running = new Map<string, Running>();
  const after = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work).catch((err: unknown) => deps.say(`Koala could not be removed from this machine: ${err instanceof Error ? err.message : String(err)}`));
    return chain;
  };
  return {
    place: (raw) => {
      const placed = placedFrom(raw);
      if (!placed) return false;
      for (const [installId, other] of running) if (installId !== placed.installId && other.instanceId === placed.instanceId) other.stop.abort();
      const entry = running.get(placed.installId) ?? { instanceId: placed.instanceId, stop: new AbortController(), runs: 0 };
      entry.runs += 1;
      running.set(placed.installId, entry);
      deps.say(`root asks for Koala on this machine (${placed.instanceId}, install ${placed.installId})`);
      void after(async () => {
        try {
          await installKoala(placed, deps, entry.stop.signal);
        } finally {
          entry.runs -= 1;
          if (entry.runs === 0 && running.get(placed.installId) === entry) running.delete(placed.installId);
        }
      });
      return true;
    },
    stop: (raw) => {
      const stop = koalaStopOf(raw);
      if (!stop) return Promise.resolve();
      running.get(stop.installId)?.stop.abort();
      return after(async () => undefined);
    },
  };
}
