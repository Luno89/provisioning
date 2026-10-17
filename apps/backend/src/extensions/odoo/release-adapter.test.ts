import { describe, it, expect } from 'vitest';
import { restoringApp } from '../../lib/release-run.js';
import { ODOO_RELEASE_ADAPTER } from './release-adapter.js';
import type { SlotCluster } from '../releases/slot-cluster.js';
import type { ReleaseTarget } from '../../lib/release-run.js';

const target: ReleaseTarget = { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' };
const vault = { projectId: 'p1', secret: 'shop-vault', keys: ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'], database: { secret: 'shop-vault', key: 'POSTGRES_PASSWORD' }, adminKey: 'ODOO_ADMIN_PASSWORD' };
const build = { image: 'reg/shop:two', source: { owner: 'bo', repo: 'shop', commit: 'two' }, vault };

function cluster(installed: string, adopt: Record<string, string> = {}) {
  const jobs: { name: string; manifest: Record<string, unknown> }[] = [];
  const execs: string[][] = [];
  const fake = {
    files: async () => ['addons/sale_note/__manifest__.py', 'addons/new_mod/__manifest__.py', 'README.md'],
    file: async (_s: unknown, path: string) => adopt[path] ?? null,
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

  it('after a client\'s database is restored, upgrades only the modules whose version the repository changed, so what the client edited in an unchanged module stays', async () => {
    const { fake, jobs } = cluster('base|20.0.1.3\nsale_note|20.0.1.0.0\nkept|20.0.2.0\n', {
      'addons/sale_note/__manifest__.py': "{'name': 'Sale note', 'version': '1.0.0'}",
      'addons/new_mod/__manifest__.py': "{'version': '20.0.1.0'}",
    });
    (fake as unknown as { files: () => Promise<string[]> }).files = async () => ['addons/sale_note/__manifest__.py', 'addons/new_mod/__manifest__.py', 'addons/kept/__manifest__.py'];
    await ODOO_RELEASE_ADAPTER.upgrade(fake, target, 'a', build, { afterRestore: true });
    const args = argsOf(jobs[0]!.manifest);
    expect(args).toEqual(expect.arrayContaining(['--init=new_mod', '--update=kept']));
    expect(args.some((arg) => arg.startsWith('--update=') && arg.includes('sale_note'))).toBe(false);
  });

  it('links the records a new module takes over to its XML ids before installing it, so they are updated and never made twice', async () => {
    const { fake, jobs, execs } = cluster('base\nsale_note\n', { 'addons/new_mod/adopt.json': JSON.stringify({ view_shop_form_7: { model: 'ir.ui.view', res_id: 7 }, odd: { model: 'res.partner', res_id: 3 } }) });
    await ODOO_RELEASE_ADAPTER.upgrade(fake, target, 'b', build);
    const takeover = execs.filter((command) => command.join(' ').includes('insert into ir_model_data'));
    expect(takeover).toHaveLength(1);
    expect(takeover[0]!.join(' ')).toContain("select 'new_mod', 'view_shop_form_7', 'ir.ui.view', 7, false");
    expect(takeover[0]).toContain('odoo_b');
    expect(jobs.map((job) => job.name)).toEqual(['shop-upgrade-b']);
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

describe('what the Odoo app holds that is not in its repository', () => {
  it('asks only the tables the database has, and reads each item back by its key on the other slot', async () => {
    const asked: string[] = [];
    const fake = {
      exec: async (_t: unknown, pod: string, command: string[]) => {
        const sql = command.at(-1)!;
        asked.push(`${pod} ${command[command.indexOf('-d') + 1]} ${sql.slice(0, 40)}`);
        if (sql.includes('pg_class')) return '["ir_model_fields","ir_ui_view"]';
        return JSON.stringify([{ kind: 'field', key: 'res.partner.x_note', name: 'The field Note (x_note) on res.partner, made in the app,', fingerprint: 'f1', active: true }]);
      },
    } as unknown as SlotCluster;
    const items = await ODOO_RELEASE_ADAPTER.inventory!(fake, target, 'a');
    expect(items).toEqual([{ kind: 'field', key: 'res.partner.x_note', name: 'The field Note (x_note) on res.partner, made in the app,', fingerprint: 'f1', active: true }]);
    expect(asked.map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual(['shop-postgres-0 odoo_a', 'shop-postgres-0 odoo_a']);
    expect(ODOO_RELEASE_ADAPTER.database(target, 'b')).toEqual({ pod: 'shop-postgres-0', user: 'odoo', database: 'odoo_b' });
  });

  it('removes its restore job when the restore ends, failed or not, so the upload\'s volume is free', async () => {
    const removed: string[] = [];
    const cluster = { job: async () => { throw new Error('ERROR missing modules: web_studio'); }, remove: async (_t: unknown, kind: string, name: string) => { removed.push(`${kind} ${name}`); } } as never;
    await expect(ODOO_RELEASE_ADAPTER.restore!(cluster, { release: 'shop', namespace: 'shop' } as never, 'a', { image: 'img', source: {} } as never, 'copy')).rejects.toThrow('missing modules');
    expect(removed).toEqual(['job shop-restore-a']);
  });

  it('restores a client\'s database, as the list of release apps says it does', () => {
    expect(typeof ODOO_RELEASE_ADAPTER.restore).toBe('function');
    expect(restoringApp(ODOO_RELEASE_ADAPTER.id)).toEqual({ title: 'Odoo' });
  });
});
