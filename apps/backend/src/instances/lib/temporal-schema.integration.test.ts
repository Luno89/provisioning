import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { CLUSTER_TOOL_PATHS } from '../../infrastructure/index.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const CHART = resolve(REPO, 'charts/instance');
const SCRIPTS = resolve(CHART, 'files');
const STAMP = randomBytes(4).toString('hex');
const NETWORK = `koala-temporal-schema-${STAMP}`;
const PASSWORD = 'temporal-schema-test';
const PREVIOUS = 'temporalio/auto-setup:1.29.3';

interface Env { name: string; value?: string; valueFrom?: unknown }
interface Container { name: string; image: string; command: string[]; env: Env[] }
interface Doc { kind: string; metadata: { name: string }; spec?: { strategy?: { type: string }; template: { spec: { initContainers: Container[]; containers: Container[] } } } }

const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8' });
const made: string[] = [];

const logsOf = (container: string): string => {
  const logs = spawnSync('docker', ['logs', '--tail', '40', container], { encoding: 'utf8' });
  return `${logs.stdout}${logs.stderr}`;
};

function healthy(container: string): Promise<void> {
  const created = docker('inspect', '-f', '{{.Created}}', container).trim();
  const events = spawn('docker', ['events', '--since', created, '--filter', `container=${container}`, '--filter', 'event=health_status', '--filter', 'event=die', '--format', '{{.Action}} {{index .Actor.Attributes "exitCode"}}']);
  return new Promise((done, failed) => {
    createInterface({ input: events.stdout }).on('line', (line) => {
      if (line.startsWith('health_status: healthy')) { events.kill(); done(); }
      if (line.startsWith('die')) { events.kill(); failed(new Error(`${container} stopped (exit ${line.slice('die '.length)}):\n${logsOf(container)}`)); }
    });
    events.on('error', failed);
  });
}

const temporalPod = (): Doc => parseAllDocuments(execFileSync(CLUSTER_TOOL_PATHS.helm, [
  'template', 'luno', CHART, '--set', 'instance.id=i', '--set', 'instance.ownerId=o', '--set', 'instance.rootUrl=https://app.example.com',
  '--set', 'instance.rootPublicKeys=PEM', '--set', 'instance.credential=c', '--set', 'publicUrl=https://luno.example.com', '--set', 'storage.total=1Gi',
], { encoding: 'utf8' })).map((doc) => doc.toJSON() as Doc).find((doc) => doc?.kind === 'Deployment' && doc.metadata.name === 'luno-temporal')!;

async function database(): Promise<string> {
  const name = `koala-temporal-db-${STAMP}-${made.length}`;
  docker('run', '-d', '--name', name, '--network', NETWORK, '--health-cmd', 'pg_isready -h 127.0.0.1 -U temporal', '--health-interval', '1s', '-e', 'POSTGRES_USER=temporal', '-e', `POSTGRES_PASSWORD=${PASSWORD}`, 'postgres:12-alpine');
  made.push(name);
  await healthy(name);
  return name;
}

const envFor = (container: Container, seeds: string): string[] => container.env.flatMap((entry) => ['-e', `${entry.name}=${entry.name === 'POSTGRES_SEEDS' ? seeds : entry.valueFrom ? PASSWORD : entry.value}`]);

function run(container: Container, seeds: string): { code: number | null; said: string } {
  const [entry, ...args] = container.command;
  const ran = spawnSync('docker', ['run', '--rm', '--network', NETWORK, '-v', `${SCRIPTS}:/schema-script:ro`, ...envFor(container, seeds), '--entrypoint', entry!, container.image, ...args], { encoding: 'utf8' });
  return { code: ran.status, said: `${ran.stdout}${ran.stderr}` };
}

const schema = (db: string): string => ['temporal', 'temporal_visibility']
  .map((name) => docker('exec', db, 'psql', '-U', 'temporal', '-d', name, '-tAc', `SELECT curr_version FROM schema_version WHERE version_partition = 0 AND db_name = '${name}'`).trim()).join(' ');

async function setUpBy(image: string, db: string): Promise<void> {
  const old = `koala-temporal-old-${STAMP}-${made.length}`;
  docker('run', '-d', '--name', old, '--network', NETWORK, '--health-cmd', 'temporal operator cluster health --address 127.0.0.1:7233 | grep -q SERVING', '--health-interval', '2s', '-e', 'DB=postgres12', '-e', 'DB_PORT=5432', '-e', 'POSTGRES_USER=temporal', '-e', `POSTGRES_PWD=${PASSWORD}`,
    '-e', `POSTGRES_SEEDS=${db}`, '-e', 'BIND_ON_IP=127.0.0.1', image);
  made.push(old);
  await healthy(old);
  docker('rm', '-f', old);
}

beforeAll(() => { docker('network', 'create', NETWORK); }, 0);
afterAll(() => {
  for (const name of made.reverse()) spawnSync('docker', ['rm', '-f', name]);
  spawnSync('docker', ['network', 'rm', NETWORK]);
}, 0);

describe('an instance\'s Temporal database brought to the schema its Temporal runs, before Temporal starts', () => {
  const pod = temporalPod();
  const setup = pod.spec!.template.spec.initContainers.find((container) => container.name === 'temporal-schema')!;
  const newest = docker('run', '--rm', '--entrypoint', 'sh', setup.image, '-c', 'for part in temporal visibility; do ls /etc/temporal/schema/postgresql/v12/$part/versioned | sed s/^v// | sort -V | tail -n 1; done').trim().split('\n').join(' ');

  it('stops the old Temporal before the new one starts', () => {
    expect(pod.spec!.strategy).toEqual({ type: 'Recreate' });
  });

  it('sets up a new database at the newest schema its Temporal knows', async () => {
    const db = await database();
    const ran = run(setup, db);
    expect(ran, ran.said).toMatchObject({ code: 0 });
    expect(schema(db)).toBe(newest);
  });

  it('brings a database the Temporal before it ran on up to its own schema, and changes nothing the second time', async () => {
    const db = await database();
    await setUpBy(PREVIOUS, db);
    expect(schema(db)).not.toBe(newest);
    const ran = run(setup, db);
    expect(ran, ran.said).toMatchObject({ code: 0 });
    expect(schema(db)).toBe(newest);
    expect(run(setup, db)).toMatchObject({ code: 0 });
    expect(schema(db)).toBe(newest);
  });

  it('refuses a database a newer Temporal ran on, saying so, and leaves it as it is', async () => {
    const db = await database();
    expect(run(setup, db)).toMatchObject({ code: 0 });
    docker('exec', db, 'psql', '-U', 'temporal', '-d', 'temporal', '-c', "UPDATE schema_version SET curr_version = '1.99' WHERE db_name = 'temporal'");
    const refused = run(setup, db);
    expect(refused.code).not.toBe(0);
    expect(refused.said).toContain('is at schema 1.99, past what this Temporal knows');
    expect(schema(db).split(' ')[0]).toBe('1.99');
  });
});
