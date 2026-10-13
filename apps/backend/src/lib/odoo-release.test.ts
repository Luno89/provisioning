import { describe, it, expect } from 'vitest';
import { NOTHING_INSTALLED, rollBackTarget, type OdooRelease, copyDatabaseScript, filestoreJob, helmSets, idleOf, modulesIn, odooJob, newReleaseName, releaseNameOf, releasePlace, releaseTargetOf, slotStateFrom, splitImage } from './odoo-release.js';

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

  it('puts a release, its namespace and its hosts under one name', () => {
    expect(releasePlace('my-shop-1a2b3c')).toEqual({ namespace: 'my-shop-1a2b3c', release: 'my-shop-1a2b3c', host: 'my-shop-1a2b3c.apps.local', previewHost: 'my-shop-1a2b3c-preview.apps.local' });
  });

  it('gives two projects with the same name different release names, each the same every time', () => {
    const first = newReleaseName({ id: 'project-a', name: 'Odoo check' });
    const second = newReleaseName({ id: 'project-b', name: 'Odoo check' });
    expect(first).toMatch(/^odoo-check-[a-z0-9]{6}$/);
    expect(second).toMatch(/^odoo-check-[a-z0-9]{6}$/);
    expect(first).not.toBe(second);
    expect(newReleaseName({ id: 'project-a', name: 'Odoo check' })).toBe(first);
  });

  it('keeps a long name short enough for its preview host to be a DNS label', () => {
    const name = newReleaseName({ id: 'p1', name: 'A shop with a very long name that keeps going and going on and on' });
    expect(`${name}-preview`.length).toBeLessThanOrEqual(63);
    expect(name).not.toMatch(/--/);
  });

  it('uses the name a project was given, else the one its releases already have', () => {
    expect(releaseNameOf({ name: 'Shop', releaseName: 'shop-1a2b3c' })).toBe('shop-1a2b3c');
    expect(releaseNameOf({ name: 'My Shop!' })).toBe('my-shop');
  });

  it('aims a release at its project\'s name and says whose it is', () => {
    expect(releaseTargetOf({ name: 'system', provider: 'k3d' }, { id: 'p1', name: 'Shop', releaseName: 'shop-1a2b3c', ownerId: 'bo' }))
      .toEqual({ clusterName: 'system', provider: 'k3d', namespace: 'shop-1a2b3c', release: 'shop-1a2b3c', owner: { ownerId: 'bo', projectId: 'p1' } });
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

describe('going back to the release before a cutover', () => {
  const release = (id: string, extra: Partial<OdooRelease>): OdooRelease => ({
    id, ownerId: 'u1', projectId: 'p1', pipelineRunId: `run-${id}`, commit: `${id}0000000`, image: `reg/shop:${id}`,
    state: 'live', host: 'shop.apps.local', startedAt: `2026-10-09T10:0${id.length}:00Z`, updatedAt: 'x', ...extra,
  });
  const before = release('a', { state: 'superseded', slot: 'a', replacedBy: 'bb' });
  const live = release('bb', { slot: 'b' });

  it('goes back to the release the live one replaced', () => {
    expect(rollBackTarget([before, live], live)).toEqual({ to: before });
  });

  it('has nothing to go back to when no release was replaced by it, or it is not live', () => {
    expect(rollBackTarget([{ ...before, replacedBy: undefined }, live], live)).toEqual({ problem: 'no earlier release is kept to go back to' });
    expect(rollBackTarget([before, live], { ...live, state: 'preview' })).toEqual({ problem: 'the release is preview, not live' });
  });

  it('refuses once a later build has reused the kept slot', () => {
    const later = release('ccc', { state: 'discarded', slot: 'a' });
    expect(rollBackTarget([before, live, later], live)).toEqual({ problem: 'the build of ccc00000 has taken the slot the earlier release was kept in' });
  });
});
