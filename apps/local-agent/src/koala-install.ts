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

export const koalaUrlOf = (placed: PlacedKoala): string =>
  (placed.domain && placed.name ? `https://${placed.name}.${placed.domain}` : `http://${placed.meshAddress}:${BACKEND_NODE_PORT}`);

export function helmArgs(placed: PlacedKoala, chart: string, rootKeysFile: string, helmKubeconfig: string = K3S_KUBECONFIG): string[] {
  const set = (name: string, value: string) => ['--set-string', `${name}=${value}`];
  const routed = Boolean(placed.domain && placed.name);
  return [
    'upgrade', '--install', KOALA_RELEASE, chart, '-n', KOALA_NAMESPACE, '--create-namespace', '--kubeconfig', helmKubeconfig,
    ...set('image.repository', placed.image),
    ...set('image.tag', placed.imageTag),
    ...(placed.imageDigest ? set('image.digest', placed.imageDigest) : []),
    ...set('instance.id', placed.instanceId),
    ...set('instance.ownerId', placed.ownerId),
    ...set('instance.rootUrl', placed.rootUrl),
    '--set-file', `instance.rootPublicKeys=${rootKeysFile}`,
    ...set('instance.credential', placed.credential),
    ...set('instance.machineId', placed.machineId),
    ...set('publicUrl', koalaUrlOf(placed)),
    '--set', `backend.nodePort=${BACKEND_NODE_PORT}`,
    ...set('mesh.loginServer', placed.meshLoginServer),
    ...set('mesh.address', placed.meshAddress),
    ...(routed ? [...set('routing.name', placed.name), ...set('routing.domain', placed.domain), '--set', `edge.nodePort=${EDGE_NODE_PORT}`] : []),
    '--wait', '--timeout', '720h',
  ];
}

export interface KoalaInstallDeps {
  cluster: ClusterHost;
  helm: string;
  fetch: typeof fetch;
  say: (line: string) => void;
  extraHelmArgs?: string[] | undefined;
}

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
    await writeFile(chartFile, chart);
    await writeFile(keysFile, placed.rootPublicKeys, { mode: 0o600 });
    await report(placed, deps.fetch, 'installing', 'installing Koala on this machine', { url });
    await deps.cluster.run(deps.helm, [...helmArgs(placed, chartFile, keysFile), ...(deps.extraHelmArgs ?? [])]);
    await report(placed, deps.fetch, 'ready', 'Installed', { url, imageTag: placed.imageTag });
    deps.say(`Koala runs on this machine at ${url}`);
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    deps.say(`Koala could not be put on this machine: ${message}`);
    await report(placed, deps.fetch, 'failed', message).catch((failure: Error) => deps.say(`root could not be told: ${failure.message}`));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
