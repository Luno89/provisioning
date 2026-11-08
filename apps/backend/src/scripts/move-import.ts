import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import {
  cleaned, restoreOrder, restoreMongo as restoreMongoFrom, volumePart, type AppsManifest, type KubeObject, GITEA_DATA, MOVED_POSTGRES,
  MOVE_STEP_WORDS, PG_RESTORE, drained, movedStateSecrets, type MovePart,
} from '../instances/index.js';
import { ensureClusterMonitoring } from '../activities/cluster-monitoring.js';
import { koalaClusterMonitoring } from '../monitoring/index.js';
import { clusterAccessFrom, InfrastructureService, terraformPlacesFor, type ClusterAccess } from '../infrastructure/index.js';
import { GiteaService } from '../projects/index.js';
import { mongoClientFor, moveImportSettingsFrom, type MoveImportSettings } from '../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import { waitingOn } from '../activities/failure-reasons.js';
import type { ReadableStream as WebReadableStream } from 'stream/web';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const HELPER = 'move-gitea-data';

let read: MoveImportSettings | undefined;
const settings = (): MoveImportSettings => {
  if (!read) throw new Error('the move has not read its settings yet');
  return read;
};
const headers = (): Record<string, string> => ({ 'x-instance-id': settings().instanceId, authorization: `Bearer ${settings().credential}` });

async function report(status: 'installing' | 'failed', detail: string): Promise<void> {
  await fetch(`${settings().rootUrl}/api/instances/status`, {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ status, detail }),
  }).catch((err: Error) => console.warn(`  root could not be told "${status}: ${detail}": ${err.message}`));
}

async function part(name: MovePart | string, saying?: string): Promise<Readable>;
async function part(name: MovePart | string, saying: string | undefined, absentFromOlder: true): Promise<Readable | undefined>;
async function part(name: MovePart | string, saying?: string, absentFromOlder?: true): Promise<Readable | undefined> {
  const words = saying ?? MOVE_STEP_WORDS[name as MovePart] ?? name;
  await report('installing', words);
  console.log(`▶ ${words}`);
  let response = await fetch(`${settings().rootUrl}/api/instances/move/parts/${encodeURIComponent(name)}`, { headers: headers() });
  while (response.status === 502 || response.status === 503) {
    await response.body?.cancel();
    console.log(`  Koala's servers are not ready to give ${name} yet (${response.status}); asking again`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    response = await fetch(`${settings().rootUrl}/api/instances/move/parts/${encodeURIComponent(name)}`, { headers: headers() });
  }
  if (absentFromOlder && response.status === 404) {
    await response.body?.cancel();
    console.log(`  Koala's servers run a release that keeps no ${name}; there is none to copy`);
    return undefined;
  }
  if (!response.ok || !response.body) {
    const said = await response.text().catch((err: Error) => `its answer could not be read: ${err.message}`);
    let reason = said;
    try { reason = (JSON.parse(said) as { error?: string }).error ?? said; } catch (err) { ignore('an answer that is not JSON is its own reason')(err); }
    throw new Error(`Koala's servers would not give ${name} (${response.status}): ${reason}`);
  }
  return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
}

function run(args: string[], input?: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let said = '';
    child.stdout!.on('data', (chunk) => { out += chunk; });
    child.stderr!.on('data', (chunk) => { said = `${said}${chunk}`.slice(-4000); });
    if (input) {
      input.on('error', (err) => { child.kill(); reject(err); });
      input.pipe(child.stdin!);
    }
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.slice(0, 4).join(' ')} ended with ${code}: ${said.trim()}`))));
  });
}

let access: ClusterAccess | undefined;
const ownCluster = (): ClusterAccess => (access ??= clusterAccessFrom(settings().clusters, { role: settings().role.role }));
export const kubectlOn = (cluster: Pick<ClusterAccess, 'kubectl' | 'pipe' | 'own'>) => (args: string[], input?: Readable): Promise<string> =>
  (input ? cluster.pipe(cluster.own(), args, input) : cluster.kubectl(cluster.own(), args));
const kubectl = (args: string[], input?: Readable): Promise<string> => kubectlOn(ownCluster())(args, input);

async function untilTrue(what: string, probe: () => Promise<boolean>): Promise<void> {
  const waiting = waitingOn(what);
  for (;;) {
    if (await probe().catch((err: unknown) => { waiting(err); return false; })) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export async function restoreMongoInto(target: { uri: string; dbName: string }, gzipped: Readable, log: (line: string) => void): Promise<number> {
  const client = mongoClientFor(target.uri);
  for (;;) {
    const unreachable = await client.connect().then(() => undefined, (err: Error) => err.message);
    if (unreachable === undefined) break;
    log(`  waiting for this machine's Mongo: ${unreachable}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  try {
    return await restoreMongoFrom(client, target.dbName, gzipped);
  } finally {
    await client.close();
  }
}

async function restoreMongo(): Promise<void> {
  console.log(`  ${await restoreMongoInto(settings().mongo, await part('mongo'), (line) => console.log(line))} records`);
}

async function restorePostgres(name: 'gitea-db' | 'infisical-db'): Promise<void> {
  const place = MOVED_POSTGRES[name];
  await untilTrue(`the pod ${place.pod} to be ready`, async () => (await kubectl(['get', 'pod', place.pod, '-n', place.namespace, '-o', 'jsonpath={.status.containerStatuses[0].ready}'])).trim() === 'true');
  await kubectl(['exec', '-i', '-n', place.namespace, place.pod, '--', 'sh', '-c', PG_RESTORE], await part(name));
}

async function restoreGiteaData(): Promise<void> {
  const { namespace, deployment, claim, path: mount } = GITEA_DATA;
  await kubectl(['scale', `deployment/${deployment}`, '-n', namespace, '--replicas=0']);
  await untilTrue('Gitea\'s pods to stop', async () => (await kubectl(['get', 'pods', '-n', namespace, '-l', 'app.kubernetes.io/name=gitea', '-o', 'name'])).trim() === '');
  await restorePostgres('gitea-db');
  await kubectl(['delete', 'pod', HELPER, '-n', namespace, '--ignore-not-found', '--wait=true']);
  const overrides = {
    spec: {
      containers: [{ name: HELPER, image: 'busybox:1.37', command: ['sleep', 'infinity'], stdin: true, volumeMounts: [{ name: 'data', mountPath: mount }] }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: claim } }],
    },
  };
  await kubectl(['run', HELPER, '-n', namespace, '--image=busybox:1.37', '--restart=Never', `--overrides=${JSON.stringify(overrides)}`]);
  await kubectl(['wait', `pod/${HELPER}`, '-n', namespace, '--for=condition=Ready', '--timeout=720h']);
  await kubectl(['exec', '-i', '-n', namespace, HELPER, '--', 'sh', '-c', drained(`find ${mount} -mindepth 1 -delete && tar xzf - -C ${mount}`)], await part('gitea-data'));
  await kubectl(['delete', 'pod', HELPER, '-n', namespace, '--wait=true']);
  await kubectl(['scale', `deployment/${deployment}`, '-n', namespace, '--replicas=1']);
  await kubectl(['rollout', 'status', `deployment/${deployment}`, '-n', namespace, '--timeout=720h']);
}

async function restoreInfisical(): Promise<void> {
  const { namespace, users } = MOVED_POSTGRES['infisical-db'];
  const selector = users!;
  const replicas = (await kubectl(['get', 'deployment', '-n', namespace, '-l', selector, '-o', 'jsonpath={.items[*].spec.replicas}'])).trim().split(/\s+/).map(Number).find((count) => count > 0) ?? 1;
  await kubectl(['scale', 'deployment', '-n', namespace, '-l', selector, '--replicas=0']);
  await untilTrue(`the pods of ${selector} to stop`, async () => (await kubectl(['get', 'pods', '-n', namespace, '-l', selector, '-o', 'name'])).trim() === '');
  await restorePostgres('infisical-db');
  await kubectl(['scale', 'deployment', '-n', namespace, '-l', selector, `--replicas=${replicas}`]);
  await kubectl(['rollout', 'status', 'deployment', '-n', namespace, '-l', selector, '--timeout=720h']);
}

async function text(stream: Readable): Promise<string> {
  let all = '';
  for await (const chunk of stream) all += chunk;
  return all;
}

const applyJson = (objects: KubeObject[], serverSide: boolean) =>
  kubectl(['apply', ...(serverSide ? ['--server-side', '--force-conflicts'] : []), '-f', '-'], Readable.from([JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects })]));

async function restoreVolume(namespace: string, claim: string): Promise<void> {
  const helper = 'koala-move-volume';
  await kubectl(['delete', 'pod', helper, '-n', namespace, '--ignore-not-found', '--wait=true']);
  const overrides = {
    spec: {
      containers: [{ name: helper, image: 'busybox:1.37', command: ['sleep', 'infinity'], stdin: true, volumeMounts: [{ name: 'volume', mountPath: '/volume' }] }],
      volumes: [{ name: 'volume', persistentVolumeClaim: { claimName: claim } }],
    },
  };
  await kubectl(['run', helper, '-n', namespace, '--image=busybox:1.37', '--restart=Never', `--overrides=${JSON.stringify(overrides)}`]);
  await kubectl(['wait', `pod/${helper}`, '-n', namespace, '--for=condition=Ready', '--timeout=720h']);
  await kubectl(['exec', '-i', '-n', namespace, helper, '--', 'sh', '-c', drained('find /volume -mindepth 1 -delete && tar xzf - -C /volume')], await part(volumePart(namespace, claim), `Copying ${namespace}'s volume ${claim}`));
  await kubectl(['delete', 'pod', helper, '-n', namespace, '--wait=true']);
}

async function restoreTerraformState(): Promise<void> {
  const namespace = settings().podNamespace;
  const given = await part('terraform-state', undefined, true);
  if (!given) return;
  const secrets = movedStateSecrets({ items: JSON.parse(await text(given)) as KubeObject[] });
  console.log(`  ${secrets.length} stacks`);
  if (secrets.length) await kubectl(['apply', '-n', namespace, '--server-side', '--force-conflicts', '-f', '-'], Readable.from([JSON.stringify({ apiVersion: 'v1', kind: 'List', items: secrets })]));
}

async function restoreApps(): Promise<void> {
  const cluster = ownCluster();
  await report('installing', 'Getting monitoring ready for your apps');
  await ensureClusterMonitoring({ access: cluster, infra: new InfrastructureService(terraformPlacesFor(settings().terraform)) }, koalaClusterMonitoring(Boolean(settings().clusters.here.poolName), cluster.own()));
  const manifest = JSON.parse(await text(await part('apps'))) as AppsManifest;
  const pullHost = await new GiteaService(settings().dataKey, settings().gitea, { registryPullHost: settings().registryPullHost }).getRegistryHost();
  for (const entry of manifest.namespaces) {
    console.log(`▶ ${entry.namespace}: ${entry.objects.length} objects, ${entry.volumes.length} volumes`);
    await applyJson([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: entry.namespace, labels: entry.labels } }], false);
    const objects = restoreOrder(entry.objects.map((object) => cleaned(object, manifest.pullHost, pullHost)));
    const claims = objects.filter((object) => object.kind === 'PersistentVolumeClaim');
    if (claims.length) await applyJson(claims, true);
    for (const volume of entry.volumes) await restoreVolume(entry.namespace, volume.claim);
    const rest = objects.filter((object) => object.kind !== 'PersistentVolumeClaim');
    if (rest.length) await applyJson(rest, true);
  }
}

async function main(): Promise<void> {
  const step = process.argv[2];
  read = moveImportSettingsFrom(process.env);
  if (step === 'data') {
    await run(['tar', 'xzf', '-', '--touch', '--no-same-owner', '-C', DATA_DIR], await part('data'));
    return;
  }
  if (step === 'restore') {
    await restoreMongo();
    await restoreGiteaData();
    await restoreInfisical();
    await restoreTerraformState();
    await restoreApps();
    await report('installing', 'Starting your instance on this machine');
    return;
  }
  throw new Error('usage: move-import data | restore');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (err: Error) => {
    console.error(err.message);
    if (read) await report('failed', `The move stopped: ${err.message}`.slice(0, 500));
    process.exit(1);
  });
}
