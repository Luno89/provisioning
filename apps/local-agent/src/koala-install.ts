import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { KOALA_INSTALL_LAST_STAGE, KOALA_MOVE_KEYS_PATH, KOALA_MOVE_LAST_STAGE, KOALA_PLATFORM_NAMESPACES, koalaInstallLastStage, koalaInstallProgressPath, koalaStopOf, MOVED_FOR_LABEL, type KoalaMove, type PlacedKoala } from '@koala/engine-core/koala-install';
import { allReporters, chartInputs, chartStep, runSteps, runsInputs, StepFailed, waiting, waitUntil, type ChartCluster, type ChartRelease, type ChartContext, type Reporter, type StepName, type Step, type WaitOptions } from '@koala/provision';
import { K3S_BINARY, K3S_KUBECONFIG, clusterState, koalaEverRan, runMachineCluster, type ClusterHost, type KoalaHeld } from './machine-cluster.js';
import { askRoot, rootProgress, rootReporter, rootUrlOf } from './root-progress.js';

export type { PlacedKoala };

export const KOALA_NAMESPACE = 'nowrinkles';
export const KOALA_RELEASE = 'instance';
export const BACKEND_NODE_PORT = 30320;
export const EDGE_NODE_PORT = 30321;

const TEXT_FIELDS = ['installId', 'instanceId', 'ownerId', 'machineId', 'rootUrl', 'rootPublicKeys', 'meshLoginServer', 'meshAddress', 'image', 'imageTag', 'chartUrl', 'credential'] as const;

const moveFrom = (raw: unknown): KoalaMove | undefined | false => {
  if (raw === undefined) return undefined;
  const from = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).fromClusterId : undefined;
  return typeof from === 'string' && from ? { fromClusterId: from } : false;
};

export function placedFrom(raw: unknown): PlacedKoala | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (!TEXT_FIELDS.every((field) => typeof record[field] === 'string' && record[field])) return undefined;
  const move = moveFrom(record.move);
  if (move === false) return undefined;
  const optional = (field: string) => (typeof record[field] === 'string' && record[field] ? record[field] : undefined);
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, record[field]])),
    imageDigest: optional('imageDigest'),
    chartSha256: optional('chartSha256'),
    name: typeof record.name === 'string' ? record.name : '',
    domain: typeof record.domain === 'string' ? record.domain : '',
    ...(move ? { move } : {}),
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
    ...(placed.move ? { move: { enabled: true, fromClusterId: placed.move.fromClusterId } } : {}),
  };
}

const moved = (placed: PlacedKoala): PlacedKoala => ({ ...placed, move: undefined });

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

async function releaseOf(ctx: InstallContext, placed: PlacedKoala = ctx.placed): Promise<ChartRelease> {
  if (!ctx.chart) throw new Error('Koala\'s chart was not fetched before it was applied');
  const values = path.join(ctx.work, placed.move ? 'koala-moving-values.json' : 'koala-values.json');
  const keys = path.join(ctx.work, 'root-keys.pem');
  const rootValues = JSON.stringify(koalaValues(placed));
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

const RELEASE_PARTS = 'app.kubernetes.io/part-of=nowrinkles-instance';

interface NamespaceList { items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }> }

export function koalaNamespacesIn(listed: unknown, instanceId: string): string[] {
  const made = new Set<string>([KOALA_NAMESPACE, ...Object.values(KOALA_PLATFORM_NAMESPACES).flat()]);
  return ((listed as NamespaceList | undefined)?.items ?? [])
    .flatMap((item) => (item.metadata?.name ? [{ name: item.metadata.name, labels: item.metadata.labels ?? {} }] : []))
    .filter((space) => made.has(space.name) || space.labels[MOVED_FOR_LABEL] === instanceId)
    .map((space) => space.name);
}

export async function removeKoala(host: ClusterHost, helm: string, instanceId: string, line: (text: string) => void, wait: WaitOptions = {}): Promise<void> {
  const cluster = machineChartCluster(host, helm);
  const released = (JSON.parse(await cluster.helm(['list', '-n', KOALA_NAMESPACE, '--filter', `^${KOALA_RELEASE}$`, '-a', '-o', 'json'])) as unknown[]).length > 0;
  const spaces = async () => koalaNamespacesIn(JSON.parse(await cluster.kubectl(['get', 'namespaces', '-o', 'json'])), instanceId);
  const found = await spaces();
  const what = [...(released ? [KOALA_RELEASE] : []), ...found];
  if (what.length) line(`removing what was put on this machine for Koala before: ${what.join(', ')}`);
  if (released) await cluster.helm(['uninstall', KOALA_RELEASE, '-n', KOALA_NAMESPACE]);
  await cluster.kubectl(['delete', 'clusterrolebinding', '-l', RELEASE_PARTS, '--ignore-not-found']);
  if (found.length) {
    await cluster.kubectl(['delete', 'namespace', ...found, '--ignore-not-found', '--wait=false']);
    await waitUntil('what was put on this machine for Koala to be gone', async () => {
      const left = await spaces();
      return left.length === 0 ? true : waiting(`${left.join(', ')} still there`);
    }, undefined, wait);
  }
  await host.letKoalaGo();
  if (what.length) line('nothing of that Koala is left on this machine');
}

const keptKoala = (machineId: string, held: KoalaHeld): string =>
  `${machineId} already runs a Koala of yours, from ${held.installId ? `its install ${held.installId}, ready since ${held.readyAt}` : 'an install made before this machine noted when its Koala was ready'}; it may hold your work, so the move removed nothing of it. Move onto another machine instead`;

const clearEarlier: Step<InstallContext> = {
  id: 'clear',
  title: 'Making room for your Koala on this machine',
  check: async (ctx) => ((await ctx.host.heldKoala())?.installId === ctx.placed.installId
    ? { done: true }
    : { done: false, why: 'this machine does not hold Koala for this move yet' }),
  apply: async (ctx, progress) => {
    const held = await ctx.host.heldKoala();
    if (held && koalaEverRan(held)) throw new Error(keptKoala(ctx.placed.machineId, held));
    if (held) await removeKoala(ctx.host, ctx.helm, held.instanceId, (text) => progress.line(text), ctx.wait);
    await ctx.host.holdKoala(ctx.placed.instanceId, ctx.placed.installId);
  },
};

const KOALA_STEP = { id: KOALA_INSTALL_LAST_STAGE, title: 'Putting Koala on this machine' };

const putKoala: Step<InstallContext> = {
  ...KOALA_STEP,
  check: async (ctx) => chartStep(KOALA_STEP, await releaseOf(ctx)).check(chartContext(ctx)),
  apply: async (ctx, progress) => chartStep(KOALA_STEP, await releaseOf(ctx)).apply(chartContext(ctx), progress),
};

export const KOALA_INSTALL_STEPS: readonly Step<InstallContext>[] = [startCluster, fetchChart, putKoala];

export const MOVED_KEYS_SECRET = `${KOALA_RELEASE}-keys`;

const KEY_LINE = /^([A-Z][A-Z0-9_]*)=(\S+)$/;

export function movedKeysOf(text: string): Record<string, string> {
  const keys: Record<string, string> = {};
  const lines = text.split('\n').map((line) => line.trim());
  lines.forEach((line, at) => {
    if (!line) return;
    const found = KEY_LINE.exec(line);
    if (!found) throw new Error(`root handed over keys this machine cannot read: line ${at + 1} is not NAME=value`);
    keys[found[1]!] = found[2]!;
  });
  if (Object.keys(keys).length === 0) throw new Error('root handed over no keys');
  return keys;
}

export const movedKeysManifest = (keys: Record<string, string>): Record<string, unknown> => ({
  apiVersion: 'v1',
  kind: 'List',
  items: [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: KOALA_NAMESPACE } },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: MOVED_KEYS_SECRET,
        namespace: KOALA_NAMESPACE,
        labels: { 'app.kubernetes.io/managed-by': 'Helm' },
        annotations: { 'meta.helm.sh/release-name': KOALA_RELEASE, 'meta.helm.sh/release-namespace': KOALA_NAMESPACE, 'helm.sh/resource-policy': 'keep' },
      },
      data: Object.fromEntries(Object.entries(keys).map(([name, value]) => [name, Buffer.from(value).toString('base64')])),
    },
  ],
});

const ASKING_FOR_KEYS = { unreachable: 'could not be asked for your Koala\'s keys', refused: 'did not hand over your Koala\'s keys' };

async function keysFromRoot(ctx: InstallContext): Promise<Record<string, string>> {
  const url = rootUrlOf(ctx.placed.rootUrl, KOALA_MOVE_KEYS_PATH);
  const init = { headers: { 'x-instance-id': ctx.placed.instanceId, authorization: `Bearer ${ctx.placed.credential}` } };
  const text = await waitUntil('root to hand over your Koala\'s keys', async () => (await askRoot(ctx.fetch, url, init, ASKING_FOR_KEYS)).text(), undefined, ctx.wait ?? {});
  return movedKeysOf(text);
}

const bringKeys: Step<InstallContext> = {
  id: 'keys',
  title: 'Bringing your Koala\'s keys over',
  check: async (ctx) => ((await machineChartCluster(ctx.host, ctx.helm).kubectl(['get', 'secret', MOVED_KEYS_SECRET, '-n', KOALA_NAMESPACE, '--ignore-not-found', '-o', 'name'])).trim()
    ? { done: true }
    : { done: false, why: 'your Koala\'s keys are not on this machine yet' }),
  apply: async (ctx, progress) => {
    const file = path.join(ctx.work, 'moved-keys.json');
    await writeFile(file, JSON.stringify(movedKeysManifest(await keysFromRoot(ctx))), { mode: 0o600 });
    try {
      await machineChartCluster(ctx.host, ctx.helm).kubectl(['apply', '-f', file]);
    } finally {
      await rm(file, { force: true });
    }
    progress.line('your Koala\'s keys are here');
  },
};

const MOVING_STEP = { id: KOALA_INSTALL_LAST_STAGE, title: 'Bringing your Koala over from Koala\'s servers' };

const bringKoala: Step<InstallContext> = {
  ...MOVING_STEP,
  check: async (ctx) => (await runsInputs(chartContext(ctx), await releaseOf(ctx, moved(ctx.placed)))
    ? { done: true }
    : chartStep(MOVING_STEP, await releaseOf(ctx)).check(chartContext(ctx))),
  apply: async (ctx, progress) => chartStep(MOVING_STEP, await releaseOf(ctx)).apply(chartContext(ctx), progress),
};

const MOVED_STEP = { id: KOALA_MOVE_LAST_STAGE, title: 'Starting your Koala on this machine' };

const startMoved: Step<InstallContext> = {
  ...MOVED_STEP,
  check: async (ctx) => chartStep(MOVED_STEP, await releaseOf(ctx, moved(ctx.placed))).check(chartContext(ctx)),
  apply: async (ctx, progress) => chartStep(MOVED_STEP, await releaseOf(ctx, moved(ctx.placed))).apply(chartContext(ctx), progress),
};

export const KOALA_MOVE_STEPS: readonly Step<InstallContext>[] = [startCluster, clearEarlier, fetchChart, bringKeys, bringKoala, startMoved];

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

const stoppedPause = (pause: (ms: number) => Promise<void>, stop: AbortSignal) => async (ms: number): Promise<void> => {
  stop.throwIfAborted();
  let quit = (): void => undefined;
  const stopped = new Promise<never>((_, refuse) => {
    quit = () => refuse(stop.reason);
    stop.addEventListener('abort', quit, { once: true });
  });
  try {
    await Promise.race([pause(ms), stopped]);
  } finally {
    stop.removeEventListener('abort', quit);
  }
};

function stoppableHost(host: ClusterHost, stop: AbortSignal): ClusterHost {
  return {
    run: async (file, args) => {
      stop.throwIfAborted();
      return host.run(file, args);
    },
    exists: (file) => host.exists(file),
    read: (file) => host.read(file),
    list: (dir) => host.list(dir),
    wanted: (running) => host.wanted(running),
    isWanted: () => host.isWanted(),
    holdKoala: (instanceId, installId, readyAt) => host.holdKoala(instanceId, installId, readyAt),
    holdsKoala: () => host.holdsKoala(),
    heldKoala: () => host.heldKoala(),
    letKoalaGo: () => host.letKoalaGo(),
    meshIp: () => host.meshIp(),
    now: () => host.now(),
    pause: stoppedPause((ms) => host.pause(ms), stop),
  };
}

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
  const last = koalaInstallLastStage(Boolean(placed.move));
  const note = async (step: StepName): Promise<void> => {
    if (step.id !== last) return;
    const held = await host.heldKoala();
    if (held?.installId !== placed.installId || held.readyAt) return;
    await host.holdKoala(placed.instanceId, placed.installId, new Date(host.now()).toISOString());
  };
  return { started: () => undefined, alreadyDone: note, line: () => undefined, done: note, failed: () => undefined };
}

const stoppedLine = (placed: PlacedKoala): string =>
  `${placed.move ? 'Moving Koala here' : 'Putting Koala on this machine'} stopped: root stopped it before it finished`;

export async function installKoala(placed: PlacedKoala, deps: KoalaInstallDeps, stop: AbortSignal = new AbortController().signal): Promise<void> {
  if (stop.aborted) {
    deps.say(stoppedLine(placed));
    return;
  }
  const own = deps.ownValues && await deps.cluster.exists(deps.ownValues) ? { file: deps.ownValues, yaml: await deps.cluster.read(deps.ownValues) } : undefined;
  const url = (own ? ownPublicUrl(own.yaml) : undefined) ?? koalaUrlOf(placed);
  const host = stoppableHost(deps.cluster, stop);
  const fetcher = stoppableFetch(deps.fetch, stop);
  const wait: WaitOptions = { ...deps.wait, pause: stoppedPause(deps.wait?.pause ?? ((ms) => deps.cluster.pause(ms)), stop) };
  const root = rootReporter(
    rootProgress(rootUrlOf(placed.rootUrl, koalaInstallProgressPath(placed.installId)), deps.token, fetcher, wait),
    { lines: true, ending: { stage: koalaInstallLastStage(Boolean(placed.move)), url } },
  );
  const work = await mkdtemp(path.join(os.tmpdir(), 'koala-install-'));
  try {
    if (!placed.move && (await deps.cluster.heldKoala())?.installId !== placed.installId) await deps.cluster.holdKoala(placed.instanceId, placed.installId);
    if (own) deps.say(`Koala takes this machine's own values from ${own.file}`);
    await runSteps(placed.move ? KOALA_MOVE_STEPS : KOALA_INSTALL_STEPS, { placed, host, helm: deps.helm, fetch: fetcher, work, own, wait }, quietOnceStopped(allReporters(saying(deps.say), notesReady(deps.cluster, placed), root), stop));
    deps.say(`Koala runs on this machine at ${url}`);
  } catch (err) {
    if (stop.aborted) deps.say(stoppedLine(placed));
    else if (!(err instanceof StepFailed)) deps.say(`Koala could not be put on this machine: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function removeMadeBy(deps: KoalaInstallDeps, installId: string): Promise<void> {
  const held = await deps.cluster.heldKoala();
  if (held?.installId !== installId) return;
  if (koalaEverRan(held)) {
    deps.say(`root asked to remove the Koala of install ${installId}, but it was ready since ${held.readyAt} and may hold your work, so nothing of it was removed`);
    return;
  }
  deps.say('removing what the stopped move put on this machine');
  await runMachineCluster(deps.cluster, { kind: 'start' });
  await removeKoala(deps.cluster, deps.helm, held.instanceId, (text) => deps.say(`  ${text}`), deps.wait);
  deps.say('nothing of the stopped move is left on this machine');
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
      return after(stop.remove ? () => removeMadeBy(deps, stop.installId) : async () => undefined);
    },
  };
}
