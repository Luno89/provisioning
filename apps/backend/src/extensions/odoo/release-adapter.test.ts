import { describe, it, expect } from 'vitest';
import { ODOO_RELEASE_ADAPTER } from './release-adapter.js';
import type { SlotCluster } from '../releases/slot-cluster.js';
import type { ReleaseTarget } from '../../lib/release-run.js';

const target: ReleaseTarget = { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' };
const vault = { projectId: 'p1', secret: 'shop-vault', keys: ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'], database: { secret: 'shop-vault', key: 'POSTGRES_PASSWORD' }, adminKey: 'ODOO_ADMIN_PASSWORD' };
const build = { image: 'reg/shop:two', source: { owner: 'bo', repo: 'shop', commit: 'two' }, vault };

function cluster(installed: string) {
  const jobs: { name: string; manifest: Record<string, unknown> }[] = [];
  const execs: string[][] = [];
  const fake = {
    files: async () => ['addons/sale_note/__manifest__.py', 'addons/new_mod/__manifest__.py', 'README.md'],
    exec: async (_t: unknown, pod: string, command: string[]) => { execs.push([pod, ...command]); return installed; },
    job: async (_t: unknown, name: string, manifest: Record<string, unknown>) => { jobs.push({ name, manifest }); },
  } as unknown as SlotCluster;
  return { fake, jobs, execs };
}

const argsOf = (manifest: Record<string, unknown>) => (manifest as { spec: { template: { spec: { containers: { args: string[] }[] } } } }).spec.template.spec.containers[0]!.args;

describe('the Odoo release adapter', () => {
  it('upgrades the modules a slot has and installs the ones it lacks, against that slot\'s database', async () => {
    const { fake, jobs } = cluster('base\nsale_note\n');
    await ODOO_RELEASE_ADAPTER.upgrade(fake, target, 'b', build);
    expect(jobs.map((job) => job.name)).toEqual(['shop-upgrade-b']);
    expect(argsOf(jobs[0]!.manifest)).toEqual(expect.arrayContaining(['--database=odoo_b', '--init=new_mod', '--update=sale_note']));
  });

  it('creates a first slot\'s database with base and every module, reading the passwords from the vault', async () => {
    const { fake, jobs } = cluster('');
    await ODOO_RELEASE_ADAPTER.init(fake, target, 'a', build);
    expect(jobs.map((job) => job.name)).toEqual(['shop-init-a']);
    expect(argsOf(jobs[0]!.manifest)).toEqual(expect.arrayContaining(['--database=odoo_a', '--init=base,new_mod,sale_note']));
    expect(JSON.stringify(jobs[0]!.manifest)).toContain('shop-vault');
  });

  it('copies the database and the filestore from one slot to the other, and quiets a preview\'s mail and jobs', async () => {
    const { fake, jobs, execs } = cluster('');
    await ODOO_RELEASE_ADAPTER.copy(fake, target, 'a', 'b', build);
    await ODOO_RELEASE_ADAPTER.quiet(fake, target, 'b');
    expect(execs[0]).toEqual(['shop-postgres-0', 'sh', '-c', expect.stringContaining('pg_dump -U odoo odoo_a | psql -q -v ON_ERROR_STOP=1 -U odoo -d odoo_b')]);
    expect(jobs.map((job) => job.name)).toEqual(['shop-filestore-b']);
    expect(execs[1]!.slice(0, 5)).toEqual(['shop-postgres-0', 'psql', '-U', 'odoo', '-d']);
    expect(execs[1]).toContain('odoo_b');
  });

  it('names its slots\' workloads and its data store', () => {
    expect(ODOO_RELEASE_ADAPTER.workload(target, 'a')).toBe('deployment/shop-odoo-a');
    expect(ODOO_RELEASE_ADAPTER.dataStore(target)).toBe('statefulset/shop-postgres');
  });
});
