import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rolloutOf, UPGRADE_WORDS, withWhy } from '../instances/index.js';

export interface SelfUpgradeDeps {
  root: { url: string; instanceId: string; credential: string };
  release: { name: string; namespace: string; current: string };
  run: (command: string, args: readonly string[]) => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface Released { imageTag: string; chartUrl: string; digest?: string; chartSha256?: string }

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CEILING = '720h';

export async function selfUpgrade(deps: SelfUpgradeDeps): Promise<boolean> {
  const call = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const log = deps.log ?? ((line: string) => console.log(line));
  const headers = { 'X-Instance-Id': deps.root.instanceId, Authorization: `Bearer ${deps.root.credential}` };
  const { name, namespace, current } = deps.release;

  const report = async (status: string, detail: string, imageTag?: string): Promise<void> => {
    const answer = await call(`${deps.root.url}/api/instances/status`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, detail, ...(imageTag ? { imageTag } : {}), presence: true }),
    }).catch((err: Error) => err);
    if (answer instanceof Error) log(`root did not hear that this instance is ${status} (${answer.message}): ${detail}`);
    else if (!answer.ok) log(`root refused hearing that this instance is ${status} (${answer.status}): ${await answer.text()}`);
  };

  const asked = await call(`${deps.root.url}/api/instances/release`, { headers });
  if (!asked.ok) throw new Error(`root did not say which release this instance should run (${asked.status}): ${await asked.text()}`);
  const wanted = await asked.json() as Released;
  if (wanted.imageTag === current) {
    await report('ready', UPGRADE_WORDS.running(current), current);
    return true;
  }

  await report('installing', UPGRADE_WORDS.upgrading(current, wanted.imageTag));
  const chart = await call(wanted.chartUrl);
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
    const upgraded = await deps.run('helm', ['upgrade', name, chartFile, '-n', namespace, '--reset-then-reuse-values', '--set', `image.tag=${wanted.imageTag}`, '--set-string', `image.digest=${wanted.digest ?? ''}`, '--timeout', CEILING])
      .then(() => rollout(), (err: Error) => ({ state: 'hopeless' as const, reason: err.message }));
    if (upgraded.state === 'done') {
      await report('ready', UPGRADE_WORDS.upgraded(wanted.imageTag), wanted.imageTag);
      return true;
    }
    log(`the upgrade to ${wanted.imageTag} cannot finish: ${upgraded.reason}; rolling back to ${current}`);
    const back = await deps.run('helm', ['rollback', name, '-n', namespace, '--timeout', CEILING])
      .then(() => rollout(), (err: Error) => ({ state: 'hopeless' as const, reason: err.message }));
    await report('failed', back.state === 'done'
      ? withWhy(UPGRADE_WORDS.rolledBack(wanted.imageTag, current), upgraded.reason)
      : withWhy(UPGRADE_WORDS.notRolledBack(wanted.imageTag, current), `${upgraded.reason}; rolling back: ${back.reason}`));
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  async function rollout(): Promise<{ state: 'done' } | { state: 'hopeless'; reason: string }> {
    let said = '';
    for (;;) {
      const listed = JSON.parse(await deps.run('kubectl', ['get', 'deployments,statefulsets,replicasets,pods', '-n', namespace, '-l', `app.kubernetes.io/instance=${name}`, '-o', 'json']));
      const now = rolloutOf(listed);
      if (now.state !== 'rolling') return now;
      if (now.waiting !== said) log(`waiting: ${now.waiting}`);
      said = now.waiting;
      await sleep(5000);
    }
  }
}

export function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { said = `${said}${chunk.toString()}`.slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args[0]} ended with ${code}: ${said.trim()}`))));
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

if (process.argv[1]?.endsWith('self-upgrade.ts')) {
  selfUpgrade({
    root: { url: required('ROOT_URL'), instanceId: required('INSTANCE_ID'), credential: required('INSTANCE_CREDENTIAL') },
    release: { name: required('RELEASE_NAME'), namespace: required('RELEASE_NAMESPACE'), current: required('CURRENT_IMAGE_TAG') },
    run: runCommand,
  }).then((ok) => { process.exitCode = ok ? 0 : 1; }, (err: Error) => { console.error(err.message); process.exitCode = 1; });
}
