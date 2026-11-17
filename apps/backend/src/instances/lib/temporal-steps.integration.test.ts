import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const CHART = resolve(REPO, 'charts/instance');
const SCRIPTS = resolve(CHART, 'files');
const STAMP = randomBytes(4).toString('hex');
const NETWORK = `koala-temporal-steps-${STAMP}`;
const PASSWORD = 'temporal-steps-test';

interface Env { name: string; value?: string; valueFrom?: unknown }
interface Container { name: string; image: string; command: string[]; env: Env[] }
interface Doc { kind: string; metadata: { name: string }; spec?: { strategy?: { type: string }; template: { spec: { initContainers: Container[]; containers: Container[] } } } }

const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8' });
const made: string[] = [];

const temporalPod = (): Doc => parseAllDocuments(execFileSync(TOOLS.helm, [
  'template', 'luno', CHART, '--set', 'instance.id=i', '--set', 'instance.ownerId=o', '--set', 'instance.rootUrl=https://app.example.com',
  '--set', 'instance.rootPublicKeys=PEM', '--set', 'instance.credential=c', '--set', 'publicUrl=https://luno.example.com', '--set', 'storage.total=1Gi',
], { encoding: 'utf8' })).map((doc) => doc.toJSON() as Doc).find((doc) => doc?.kind === 'Deployment' && doc.metadata.name === 'luno-temporal')!;

function database(): string {
  const name = `koala-temporal-db-${STAMP}-${made.length}`;
  docker('run', '-d', '--name', name, '--network', NETWORK, '-e', 'POSTGRES_USER=temporal', '-e', `POSTGRES_PASSWORD=${PASSWORD}`, 'postgres:12-alpine');
  made.push(name);
  return name;
}

const envFor = (container: Container, seeds: string): string[] => container.env.flatMap((entry) => ['-e', `${entry.name}=${entry.name === 'POSTGRES_SEEDS' ? seeds : entry.valueFrom ? PASSWORD : entry.value}`]);

function run(container: Container, seeds: string, steps: string): { code: number | null; said: string } {
  const [entry, ...args] = container.command;
  const ran = spawnSync('docker', ['run', '--rm', '--network', NETWORK, '-v', `${steps}:/steps`, '-v', `${SCRIPTS}:/steps-script:ro`,
    ...envFor(container, seeds), '--entrypoint', entry!, container.image, ...args], { encoding: 'utf8' });
  return { code: ran.status, said: `${ran.stdout}${ran.stderr}` };
}

const schema = (db: string): string => ['temporal', 'temporal_visibility']
  .map((name) => docker('exec', db, 'psql', '-U', 'temporal', '-d', name, '-tAc', `SELECT curr_version FROM schema_version WHERE version_partition = 0 AND db_name = '${name}'`).trim()).join(' ');

function setUpAt(image: string, db: string): void {
  const old = `koala-temporal-old-${STAMP}-${made.length}`;
  docker('run', '-d', '--name', old, '--network', NETWORK, '-e', 'DB=postgres12', '-e', 'DB_PORT=5432', '-e', 'POSTGRES_USER=temporal', '-e', `POSTGRES_PWD=${PASSWORD}`,
    '-e', `POSTGRES_SEEDS=${db}`, '-e', 'BIND_ON_IP=127.0.0.1', image);
  made.push(old);
  while (spawnSync('docker', ['exec', old, 'temporal', 'operator', 'cluster', 'health', '--address', '127.0.0.1:7233'], { encoding: 'utf8' }).stdout.includes('SERVING') === false) execFileSync('sleep', ['2']);
  docker('rm', '-f', old);
}

const volume = (): string => {
  const name = `koala-temporal-steps-${STAMP}-${made.length}`;
  docker('volume', 'create', name);
  made.push(`volume:${name}`);
  return name;
};

beforeAll(() => { docker('network', 'create', NETWORK); }, 0);
afterAll(() => {
  for (const name of made.reverse()) {
    if (name.startsWith('volume:')) spawnSync('docker', ['volume', 'rm', '-f', name.slice('volume:'.length)]);
    else spawnSync('docker', ['rm', '-f', name]);
  }
  spawnSync('docker', ['network', 'rm', NETWORK]);
}, 0);

describe('an instance\'s Temporal stepped up one minor version at a time before it starts', () => {
  const pod = temporalPod();
  const inits = pod.spec!.template.spec.initContainers;
  const plan = inits.find((container) => container.name === 'temporal-plan')!;
  const steps = inits.filter((container) => container.name.startsWith('temporal-step-'));
  const main = pod.spec!.template.spec.containers.find((container) => container.name === 'temporal')!;

  it('stops the old Temporal before the new one starts, and knows the schema its own Temporal brings', () => {
    expect(pod.spec!.strategy).toEqual({ type: 'Recreate' });
    expect(steps.map((step) => step.image)).toEqual(['temporalio/auto-setup:1.25.2', 'temporalio/auto-setup:1.26.3', 'temporalio/auto-setup:1.27.4', 'temporalio/auto-setup:1.28.4']);
    const brought = docker('run', '--rm', '--entrypoint', 'sh', main.image, '-c', 'for part in temporal visibility; do ls /etc/temporal/schema/postgresql/v12/$part/versioned | sed s/^v// | sort -V | tail -n 1; done').trim().split('\n');
    expect(plan.env.filter((entry) => entry.name.startsWith('NEWEST_')).map((entry) => entry.value)).toEqual(brought);
  });

  it('takes a database Temporal 1.24 set up through every minor version up to the one before its own, and does nothing the second time', () => {
    const db = database();
    setUpAt('temporalio/auto-setup:1.24.2', db);
    expect(schema(db)).toBe('1.12 1.6');
    const at = volume();
    const planned = run(plan, db, at);
    expect(planned, planned.said).toMatchObject({ code: 0 });
    expect(planned.said).toContain('Temporal\'s database is at schema 1.12 (visibility 1.6)');
    for (const step of steps) {
      const stepped = run(step, db, at);
      expect(stepped, stepped.said).toMatchObject({ code: 0 });
    }
    expect(schema(db)).toBe('1.17 1.9');
    const again = volume();
    expect(run(plan, db, again).said).toContain('at schema 1.17 (visibility 1.9)');
    for (const step of steps) expect(run(step, db, again).said).toContain('already at schema 1.17');
  });

  it('leaves a new database to the Temporal that runs it', () => {
    const db = database();
    const at = volume();
    expect(run(plan, db, at).said).toContain('holds no schema yet');
    for (const step of steps) expect(run(step, db, at).said).toContain('a new database goes straight to the Temporal that runs it');
  });

  it('refuses a database a newer Temporal ran on, saying so, and starts nothing', () => {
    const db = database();
    setUpAt('temporalio/auto-setup:1.24.2', db);
    docker('exec', db, 'psql', '-U', 'temporal', '-d', 'temporal', '-c', "UPDATE schema_version SET curr_version = '1.99' WHERE db_name = 'temporal'");
    const refused = run(plan, db, volume());
    expect(refused.code).not.toBe(0);
    expect(refused.said).toContain('past what this Temporal knows (1.18, visibility 1.9): a newer Temporal ran on it, and this one cannot');
  });
});
