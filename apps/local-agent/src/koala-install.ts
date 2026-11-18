import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { KOALA_INSTALL_LAST_STAGE, koalaInstallProgressPath, type PlacedKoala } from '@koala/engine-core/koala-install';
import { allReporters, chartInputs, chartStep, runSteps, StepFailed, type ChartCluster, type ChartRelease, type Reporter, type Step, type WaitOptions } from '@koala/provision';
import { K3S_BINARY, K3S_KUBECONFIG, clusterState, runMachineCluster, type ClusterHost } from './machine-cluster.js';
import { rootProgress, rootReporter, rootUrlOf } from './root-progress.js';

export type { PlacedKoala };

export const KOALA_NAMESPACE = 'nowrinkles';
export const KOALA_RELEASE = 'instance';
export const BACKEND_NODE_PORT = 30320;
export const EDGE_NODE_PORT = 30321;

const TEXT_FIELDS = ['installId', 'instanceId', 'ownerId', 'machineId', 'rootUrl', 'rootPublicKeys', 'meshLoginServer', 'meshAddress', 'image', 'imageTag', 'chartUrl', 'credential'] as const;

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
    instance: { id: placed.instanceId, ownerId: placed.ownerId, rootUrl: placed.rootUrl, credential: placed.credential, machineId: placed.machineId },
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

export const machineChartCluster = (host: ClusterHost, helm: string): ChartCluster => ({
  helm: (args) => host.run(helm, [...args, '--kubeconfig', K3S_KUBECONFIG]),
  kubectl: (args) => host.run(K3S_BINARY, ['kubectl', '--kubeconfig', K3S_KUBECONFIG, ...args]),
});

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

const KOALA_STEP = { id: KOALA_INSTALL_LAST_STAGE, title: 'Putting Koala on this machine' };

const putKoala: Step<InstallContext> = {
  ...KOALA_STEP,
  check: async (ctx) => chartStep(KOALA_STEP, await releaseOf(ctx)).check({ cluster: machineChartCluster(ctx.host, ctx.helm), ...(ctx.wait ? { wait: ctx.wait } : {}) }),
  apply: async (ctx, progress) => chartStep(KOALA_STEP, await releaseOf(ctx)).apply({ cluster: machineChartCluster(ctx.host, ctx.helm), ...(ctx.wait ? { wait: ctx.wait } : {}) }, progress),
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

export async function installKoala(placed: PlacedKoala, deps: KoalaInstallDeps): Promise<void> {
  const own = deps.ownValues && await deps.cluster.exists(deps.ownValues) ? { file: deps.ownValues, yaml: await deps.cluster.read(deps.ownValues) } : undefined;
  const url = (own ? ownPublicUrl(own.yaml) : undefined) ?? koalaUrlOf(placed);
  const root = rootReporter(
    rootProgress(rootUrlOf(placed.rootUrl, koalaInstallProgressPath(placed.installId)), deps.token, deps.fetch, deps.wait ?? {}),
    { lines: true, ending: { stage: KOALA_INSTALL_LAST_STAGE, url } },
  );
  const work = await mkdtemp(path.join(os.tmpdir(), 'koala-install-'));
  try {
    await deps.cluster.holdKoala(placed.instanceId);
    if (own) deps.say(`Koala takes this machine's own values from ${own.file}`);
    await runSteps(KOALA_INSTALL_STEPS, { placed, host: deps.cluster, helm: deps.helm, fetch: deps.fetch, work, own, wait: deps.wait }, allReporters(saying(deps.say), root));
    deps.say(`Koala runs on this machine at ${url}`);
  } catch (err) {
    if (!(err instanceof StepFailed)) deps.say(`Koala could not be put on this machine: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

