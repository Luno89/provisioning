import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { K3S_KUBECONFIG, runMachineCluster, type ClusterHost } from './machine-cluster.js';

export interface PlacedKoala {
  instanceId: string;
  ownerId: string;
  machineId: string;
  rootUrl: string;
  rootPublicKeys: string;
  meshLoginServer: string;
  meshAddress: string;
  image: string;
  imageTag: string;
  imageDigest?: string | undefined;
  chartUrl: string;
  chartSha256?: string | undefined;
  credential: string;
  name: string;
  domain: string;
}

export const KOALA_NAMESPACE = 'nowrinkles';
export const KOALA_RELEASE = 'instance';
export const BACKEND_NODE_PORT = 30320;
export const EDGE_NODE_PORT = 30321;

const TEXT_FIELDS = ['instanceId', 'ownerId', 'machineId', 'rootUrl', 'rootPublicKeys', 'meshLoginServer', 'meshAddress', 'image', 'imageTag', 'chartUrl', 'credential'] as const;

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

export function koalaValues(placed: PlacedKoala): Record<string, unknown> {
  const routed = Boolean(placed.domain && placed.name);
  return {
    image: { repository: placed.image, tag: placed.imageTag, ...(placed.imageDigest ? { digest: placed.imageDigest } : {}) },
    instance: { id: placed.instanceId, ownerId: placed.ownerId, rootUrl: placed.rootUrl, credential: placed.credential, machineId: placed.machineId },
    publicUrl: koalaUrlOf(placed),
    backend: { nodePort: BACKEND_NODE_PORT },
    mesh: { loginServer: placed.meshLoginServer, address: placed.meshAddress },
    ...(routed ? { routing: { name: placed.name, domain: placed.domain }, edge: { nodePort: EDGE_NODE_PORT } } : {}),
  };
}

export function helmArgs(chart: string, valuesFiles: string[], rootKeysFile: string, helmKubeconfig: string = K3S_KUBECONFIG): string[] {
  return [
    'upgrade', '--install', KOALA_RELEASE, chart, '-n', KOALA_NAMESPACE, '--create-namespace', '--kubeconfig', helmKubeconfig,
    ...valuesFiles.flatMap((file) => ['-f', file]),
    '--set-file', `instance.rootPublicKeys=${rootKeysFile}`,
    '--wait', '--timeout', '720h',
  ];
}

export function servedUrl(valuesJson: string): string | undefined {
  try {
    const value = (JSON.parse(valuesJson) as { publicUrl?: unknown }).publicUrl;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface KoalaInstallDeps {
  cluster: ClusterHost;
  helm: string;
  fetch: typeof fetch;
  say: (line: string) => void;
  ownValues?: string | undefined;
}

export const ownValuesFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'koala', 'koala-values.yaml');

type Status = 'installing' | 'ready' | 'failed';

async function report(placed: PlacedKoala, fetchImpl: typeof fetch, status: Status, detail: string, extra: Record<string, unknown> = {}): Promise<void> {
  const answer = await fetchImpl(`${placed.rootUrl}/api/instances/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-instance-id': placed.instanceId, authorization: `Bearer ${placed.credential}` },
    body: JSON.stringify({ status, detail, meshIp: placed.meshAddress, presence: true, ...extra }),
  });
  if (!answer.ok) throw new Error(`root refused the report that Koala is ${status} (${answer.status}): ${(await answer.text()).slice(0, 300)}`);
}

export async function installKoala(placed: PlacedKoala, deps: KoalaInstallDeps): Promise<void> {
  const url = koalaUrlOf(placed);
  const work = await mkdtemp(path.join(os.tmpdir(), 'koala-install-'));
  try {
    await deps.cluster.holdKoala(placed.instanceId);
    await report(placed, deps.fetch, 'installing', 'starting this machine\'s cluster', { url });
    await runMachineCluster(deps.cluster, { kind: 'start' });
    deps.say('this machine\'s cluster runs; fetching Koala');
    const chart = Buffer.from(await (await deps.fetch(placed.chartUrl).then((answer) => {
      if (!answer.ok) throw new Error(`root's chart answered ${answer.status}`);
      return answer;
    })).arrayBuffer());
    const sha = createHash('sha256').update(chart).digest('hex');
    if (placed.chartSha256 && sha !== placed.chartSha256) throw new Error('the chart root sent is not the one it released (its sha256 differs); nothing was installed');
    const chartFile = path.join(work, 'instance-chart.tgz');
    const keysFile = path.join(work, 'root-keys.pem');
    const valuesFile = path.join(work, 'koala-values.json');
    await writeFile(chartFile, chart);
    await writeFile(keysFile, placed.rootPublicKeys, { mode: 0o600 });
    await writeFile(valuesFile, JSON.stringify(koalaValues(placed)), { mode: 0o600 });
    await report(placed, deps.fetch, 'installing', 'installing Koala on this machine', { url });
    const own = deps.ownValues && await deps.cluster.exists(deps.ownValues) ? [deps.ownValues] : [];
    if (own.length) deps.say(`Koala takes this machine's own values from ${deps.ownValues}`);
    await deps.cluster.run(deps.helm, helmArgs(chartFile, [valuesFile, ...own], keysFile));
    const served = servedUrl(await deps.cluster.run(deps.helm, ['get', 'values', KOALA_RELEASE, '-n', KOALA_NAMESPACE, '--kubeconfig', K3S_KUBECONFIG, '--all', '-o', 'json'])) ?? url;
    await report(placed, deps.fetch, 'ready', 'Installed', { url: served, imageTag: placed.imageTag });
    deps.say(`Koala runs on this machine at ${served}`);
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    deps.say(`Koala could not be put on this machine: ${message}`);
    await report(placed, deps.fetch, 'failed', message).catch((failure: Error) => deps.say(`root could not be told: ${failure.message}`));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
