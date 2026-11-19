import { spawn } from 'child_process';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import {
  InstanceReporter, MOVE_STEP_WORDS, MoveParts, movedRecordsIn, movedStateSecrets, restoreMongo as restoreMongoFrom, retargetedStateSecrets, textOf,
  type KubeObject, type MovePart,
} from '../instances/index.js';
import { clusterAccessFrom, MOVE_IN_ID, type ClusterAccess } from '../infrastructure/index.js';
import { childEnv, createDatabase, failureOf, leaseMongo, moveImportSettingsFrom, reopening, type MongoLease, type MoveImportSettings, type PlatformKeys } from '../platform/index.js';

function run(args: string[], input?: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: childEnv() });
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

export const kubectlOn = (cluster: Pick<ClusterAccess, 'kubectl' | 'pipe' | 'own'>) => (args: string[], input?: Readable): Promise<string> =>
  (input ? cluster.pipe(cluster.own(), args, input) : cluster.kubectl(cluster.own(), args));

export async function restoreMongoInto(target: { uri: string; dbName: string }, gzipped: Readable, log: (line: string) => void): Promise<number> {
  const again = reopening(3_000);
  let lease: MongoLease | undefined;
  while (!lease) {
    lease = await leaseMongo(target.uri).catch((err: Error) => {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw err;
      log(`  waiting for this machine's Mongo: ${failure.reason}; trying again in ${again.seconds} s`);
      return undefined;
    });
    if (!lease) await again.after();
  }
  try {
    return await restoreMongoFrom(lease.client, target.dbName, gzipped);
  } finally {
    await lease.release();
  }
}

export interface MoveMongoDeps {
  target: { uri: string; dbName: string };
  from: string;
  onto: string;
  ownerId: string;
  namespace: string;
  dataKey: PlatformKeys['data'];
  parts: Pick<MoveParts, 'part'>;
  kubectl: (args: string[], input?: Readable) => Promise<string>;
  say: (line: string) => void;
  now?: () => string;
}

export async function moveMongo(deps: MoveMongoDeps): Promise<void> {
  deps.say(`  ${await restoreMongoInto(deps.target, await deps.parts.part('mongo'), deps.say)} records`);
  const lease = await leaseMongo(deps.target.uri);
  try {
    const moved = movedRecordsIn(lease.client.db(deps.target.dbName));
    const deploymentIds = await moved.appsOnCluster(deps.from);
    deps.say(`  ${await moved.retargetCluster(deps.from, deps.onto)} records moved from ${deps.from} onto ${deps.onto}`);
    const given = await deps.parts.part('terraform-state', undefined, true);
    if (given) {
      const secrets = retargetedStateSecrets(movedStateSecrets({ items: JSON.parse(await textOf(given)) as KubeObject[] }), { from: deps.from, onto: deps.onto, deploymentIds });
      deps.say(`  ${secrets.length} stacks`);
      if (secrets.length) await deps.kubectl(['apply', '-n', deps.namespace, '--server-side', '--force-conflicts', '-f', '-'], Readable.from([JSON.stringify({ apiVersion: 'v1', kind: 'List', items: secrets })]));
    }
  } finally {
    await lease.release();
  }
  const records = createDatabase({ mongo: deps.target, dataKey: deps.dataKey });
  try {
    await records.init();
    await records.infrastructure.saveMoveIn({ id: MOVE_IN_ID, ownerId: deps.ownerId, from: deps.from, onto: deps.onto, at: (deps.now ?? (() => new Date().toISOString()))() });
  } finally {
    await records.close();
  }
}

async function main(): Promise<void> {
  const step = process.argv[2];
  const settings: MoveImportSettings = moveImportSettingsFrom(process.env);
  const reporter = new InstanceReporter({ root: { url: settings.rootUrl, instanceId: settings.instanceId, credential: settings.credential } });
  const tell = async (status: 'installing' | 'failed', detail: string): Promise<void> => {
    const answer = await reporter.status({ status, detail });
    if (!answer.ok) throw new Error(`root refused hearing "${detail}" (${answer.status}): ${answer.error}`);
  };
  const parts = new MoveParts({
    root: { url: settings.rootUrl, instanceId: settings.instanceId, credential: settings.credential },
    say: async (line) => {
      console.log(line.startsWith(' ') ? line : `▶ ${line}`);
      if (!line.startsWith(' ')) await tell('installing', line);
    },
  });
  try {
    if (step === 'data') {
      await run(['tar', 'xzf', '-', '--touch', '--no-same-owner', '-C', settings.dataDir], await parts.part('data'));
      return;
    }
    if (step === 'mongo') {
      const access = clusterAccessFrom(settings.clusters, { role: settings.role.role });
      await moveMongo({
        target: settings.mongo, from: settings.from, onto: settings.onto, ownerId: settings.ownerId, namespace: settings.podNamespace, dataKey: settings.dataKey,
        parts, kubectl: kubectlOn(access), say: (line) => console.log(line),
      });
      return;
    }
    throw new Error('usage: move-import data | mongo');
  } catch (err) {
    const words = MOVE_STEP_WORDS[step === 'data' ? 'data' : 'mongo' as MovePart];
    await tell('failed', `${words} stopped: ${(err as Error).message}`.slice(0, 500)).catch((refused: Error) => console.error(refused.message));
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
