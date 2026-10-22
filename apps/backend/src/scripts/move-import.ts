import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { importLines } from '../instances/lib/mongo-move.js';
import { cleaned, restoreOrder, volumePart, type AppsManifest, type KubeObject } from '../instances/lib/app-move.js';
import { ensureClusterMonitoring } from '../activities/cluster-monitoring.js';
import { SYSTEM_CLUSTER } from '../monitoring/lib/cluster-monitoring.js';
import { InfrastructureService } from '../infrastructure/services/InfrastructureService.js';
import { GiteaService } from '../projects/services/GiteaService.js';
import { loadKeys } from '../platform/lib/keys.js';
import { mongoTarget } from '../platform/lib/mongo-db.js';
import { GITEA_DATA, MOVED_POSTGRES, MOVE_STEP_WORDS, PG_RESTORE, drained, type MovePart } from '../instances/lib/instance-move.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const HELPER = 'move-gitea-data';

const rootUrl = (process.env.ROOT_URL ?? '').replace(/\/$/, '');
const instanceId = process.env.INSTANCE_ID ?? '';
const credential = process.env.INSTANCE_CREDENTIAL ?? '';
const headers = { 'x-instance-id': instanceId, authorization: `Bearer ${credential}` };

async function report(status: 'installing' | 'failed', detail: string): Promise<void> {
  await fetch(`${rootUrl}/api/instances/status`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status, detail }),
  }).catch(() => undefined);
}

async function part(name: MovePart | string, saying?: string): Promise<Readable> {
  const words = saying ?? MOVE_STEP_WORDS[name as MovePart] ?? name;
  await report('installing', words);
  console.log(`▶ ${words}`);
  let response = await fetch(`${rootUrl}/api/instances/move/parts/${encodeURIComponent(name)}`, { headers });
  while (response.status === 502 || response.status === 503) {
    await response.body?.cancel();
    console.log(`  Koala's servers are not ready to give ${name} yet (${response.status}); asking again`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    response = await fetch(`${rootUrl}/api/instances/move/parts/${encodeURIComponent(name)}`, { headers });
  }
  if (!response.ok || !response.body) {
    const said = await response.text().catch(() => '');
    let reason = said;
    try { reason = (JSON.parse(said) as { error?: string }).error ?? said; } catch { /* plain text */ }
    throw new Error(`Koala's servers would not give ${name} (${response.status}): ${reason}`);
  }
  return Readable.fromWeb(response.body as never);
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

const kubectl = (args: string[], input?: Readable) => run(['kubectl', ...args], input);

async function untilTrue(probe: () => Promise<boolean>): Promise<void> {
  for (;;) {
    if (await probe().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function restoreMongo(): Promise<void> {
  const target = mongoTarget(process.env);
  const client = new MongoClient(target.uri);
  for (;;) {
    const connected = await client.connect().then(() => true, () => false);
    if (connected) break;
    console.log('  waiting for this machine\'s Mongo');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  try {
    const lines = readline.createInterface({ input: (await part('mongo')).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    console.log(`  ${await importLines(lines, client.db(target.dbName))} records`);
  } finally {
    await client.close();
  }
}

async function restorePostgres(name: 'gitea-db' | 'infisical-db'): Promise<void> {
  const place = MOVED_POSTGRES[name];
  await untilTrue(async () => (await kubectl(['get', 'pod', place.pod, '-n', place.namespace, '-o', 'jsonpath={.status.containerStatuses[0].ready}'])).trim() === 'true');
  await kubectl(['exec', '-i', '-n', place.namespace, place.pod, '--', 'sh', '-c', PG_RESTORE], await part(name));
}

async function restoreGiteaData(): Promise<void> {
  const { namespace, deployment, claim, path: mount } = GITEA_DATA;
  await kubectl(['scale', `deployment/${deployment}`, '-n', namespace, '--replicas=0']);
  await untilTrue(async () => (await kubectl(['get', 'pods', '-n', namespace, '-l', 'app.kubernetes.io/name=gitea', '-o', 'name'])).trim() === '');
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
  await untilTrue(async () => (await kubectl(['get', 'pods', '-n', namespace, '-l', selector, '-o', 'name'])).trim() === '');
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

async function restoreApps(): Promise<void> {
  const kubeconfigPath = process.env.KUBECONFIG_PATH ?? '/tmp/kubeconfig-provisioning-lunorica';
  await report('installing', 'Getting monitoring ready for your apps');
  await ensureClusterMonitoring(new InfrastructureService(), { physicalName: SYSTEM_CLUSTER, kubeconfigPath, local: false });
  const manifest = JSON.parse(await text(await part('apps'))) as AppsManifest;
  const pullHost = await new GiteaService(new InfrastructureService(), loadKeys(process.env).data, kubeconfigPath).getRegistryHost();
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
  if (!rootUrl || !instanceId || !credential) throw new Error('this machine does not know its root, its instance or its credential');
  if (step === 'data') {
    await run(['tar', 'xzf', '-', '--touch', '--no-same-owner', '-C', DATA_DIR], await part('data'));
    return;
  }
  if (step === 'restore') {
    await restoreMongo();
    await restoreGiteaData();
    await restoreInfisical();
    await restoreApps();
    await report('installing', 'Starting your instance on this machine');
    return;
  }
  throw new Error('usage: move-import data | restore');
}

main().catch(async (err: Error) => {
  console.error(err.message);
  await report('failed', `The move stopped: ${err.message}`.slice(0, 500));
  process.exit(1);
});
