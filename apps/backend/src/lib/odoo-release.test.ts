import { describe, it, expect } from 'vitest';
import { NOTHING_INSTALLED, copyDatabaseScript, filestoreJob, helmSets, idleOf, modulesIn, odooJob, releasePlace, slotStateFrom, splitImage } from './odoo-release.js';

describe('the two slots of an Odoo project', () => {
  it('prepares the next version in the slot that is not live', () => {
    expect(idleOf('a')).toBe('b');
    expect(idleOf('b')).toBe('a');
  });

  it('reads which slot is live and what each runs from the release\'s values, and nothing from no release', () => {
    expect(slotStateFrom({ live: 'b', slots: { a: { tag: 'one' }, b: { tag: 'two' } }, previewHost: 'p.local' }))
      .toEqual({ installed: true, live: 'b', tags: { a: 'one', b: 'two' }, previewHost: 'p.local' });
    expect(slotStateFrom({ live: 'a', slots: { a: { tag: '' }, b: {} } })).toEqual({ installed: true, live: 'a', tags: { a: undefined, b: undefined } });
    expect(slotStateFrom(null)).toBe(NOTHING_INSTALLED);
  });

  it('sets every value the platform owns, as strings, so a tag that looks like a number stays a tag', () => {
    expect(helmSets({ repository: 'reg/o/shop', state: { installed: true, live: 'b', tags: { a: '1234', b: undefined } }, host: 'shop.apps.local' })).toEqual([
      '--set-string', 'image.repository=reg/o/shop',
      '--set-string', 'live=b',
      '--set-string', 'host=shop.apps.local',
      '--set-string', 'previewHost=',
      '--set-string', 'slots.a.tag=1234',
      '--set-string', 'slots.b.tag=',
    ]);
  });

  it('names a project\'s namespace, release and hosts from its name', () => {
    expect(releasePlace('My Shop!')).toEqual({ namespace: 'my-shop', release: 'my-shop', host: 'my-shop.apps.local', previewHost: 'my-shop-preview.apps.local' });
  });

  it('splits a built image into its repository and tag, registry port and all', () => {
    expect(splitImage('10.0.0.1:31737/bo/shop:c0ffee')).toEqual({ repository: '10.0.0.1:31737/bo/shop', tag: 'c0ffee' });
    expect(() => splitImage('10.0.0.1:31737/bo/shop')).toThrow(/has no tag/);
  });

  it('finds the modules a repository holds from their manifests', () => {
    expect(modulesIn(['addons/sale_note/__manifest__.py', 'addons/sale_note/models/x.py', 'addons/README.md', 'addons/stock_x/__manifest__.py', 'deploy/chart/Chart.yaml']))
      .toEqual(['sale_note', 'stock_x']);
  });
});

describe('the jobs a release runs', () => {
  it('installs and updates modules in one slot\'s database with the new image, against the project\'s Postgres', () => {
    const job = odooJob({ name: 'shop-upgrade-b', release: 'shop', image: 'reg/shop:two', database: 'odoo_b', install: ['new_mod'], update: ['sale_note', 'new_mod'] }) as { spec: { template: { spec: { containers: { image: string; args: string[] }[] } } } };
    const container = job.spec.template.spec.containers[0]!;
    expect(container.image).toBe('reg/shop:two');
    expect(container.args).toEqual(expect.arrayContaining(['--database=odoo_b', '--init=new_mod', '--update=sale_note,new_mod', '--stop-after-init', '--db_host=shop-postgres']));
  });

  it('leaves out --init and --update when there is nothing to install or update', () => {
    const job = odooJob({ name: 'j', release: 'shop', image: 'i:t', database: 'odoo_a', install: [], update: [] }) as { spec: { template: { spec: { containers: { args: string[] }[] } } } };
    expect(job.spec.template.spec.containers[0]!.args.some((arg) => arg.startsWith('--init') || arg.startsWith('--update'))).toBe(false);
  });

  it('copies one slot\'s attachments over the other\'s, and the live database over the idle one', () => {
    const job = filestoreJob({ name: 'j', release: 'shop', image: 'i:t', from: 'odoo_a', to: 'odoo_b' }) as { spec: { template: { spec: { containers: { command: string[] }[] } } } };
    expect(job.spec.template.spec.containers[0]!.command[2]).toBe('rm -rf /var/lib/odoo/filestore/odoo_b && if [ -d /var/lib/odoo/filestore/odoo_a ]; then cp -a /var/lib/odoo/filestore/odoo_a /var/lib/odoo/filestore/odoo_b; fi');
    expect(copyDatabaseScript('odoo_a', 'odoo_b')).toBe('dropdb --if-exists -U odoo odoo_b && createdb -U odoo odoo_b && pg_dump -U odoo odoo_a | psql -q -v ON_ERROR_STOP=1 -U odoo -d odoo_b > /dev/null');
  });
});
