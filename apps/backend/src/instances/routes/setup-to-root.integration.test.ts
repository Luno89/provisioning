import { afterEach, describe, expect, it } from 'vitest';
import { reopening } from '@koala/engine-core/reopening';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE, type ProvisionReport } from '@koala/engine-core/koala-install';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { InstanceReporter } from '../services/InstanceReporter.js';
import { rootInstallsServed } from '../testing/root-installs.js';
import { tokenOfInstance } from '../testing/placed-koala.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const DESK = { id: 'desk', name: 'desk', meshIp: '100.64.0.7' };
const gitea = { stage: 'gitea', title: 'Gitea, your repositories and images' };
const setUp = { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' as const };

async function root() {
  const db: Database = await testDatabase();
  const handed: Array<[string, ProvisionReport]> = [];
  const { instances, url } = await rootInstallsServed(db, { start: async () => undefined, progress: async () => undefined, setup: async (installId, report) => { handed.push([installId, report]); }, reconnected: async () => undefined, cancel: async () => undefined }, closers);
  const placed = await instances.placeOn('bo', DESK, 'bobby', 'install-1');
  if (!placed.ok) throw new Error(placed.error);
  const koala = await instances.placedKoala('install-1', DESK);
  if (!koala.ok) throw new Error(koala.error);
  const reporter = new InstanceReporter({ root: { url, instanceId: placed.value.instanceId, token: async () => tokenOfInstance(koala.value.instanceId) }, wait: reopening(1), log: () => undefined });
  const record = async () => (await db.instances.getInstances('bo'))[0]!;
  return { db, instances, handed, reporter, record };
}

describe('the instance telling root how its setup goes, through root\'s real route and records', () => {
  it('hands each line to the install of Koala on the machine while that install runs, and root records nothing beside it', async () => {
    const { handed, reporter, record } = await root();
    const line = { revision: 1, progress: { ...gitea, state: 'started' as const, line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' } };
    expect(await reporter.setup(line)).toEqual({ ok: true });
    expect(handed).toEqual([['install-1', line]]);
    expect(await record()).toMatchObject({ status: 'joined', install: { state: 'asked' } });
    expect((await record()).setup).toBeUndefined();
  });

  it('once the install has ended, records each line itself, failed at the piece that stopped and ready once the setup says so, for My Machines to show', async () => {
    const { db, instances, handed, reporter, record } = await root();
    await db.instances.updateInstall((await record()).id, 'install-1', { 'install.state': 'failed', 'install.why': 'Infisical stopped', status: 'failed', detail: 'Koala on desk stopped setting itself up at Infisical' });
    expect(await reporter.setup({ revision: 2, progress: { ...gitea, state: 'started', line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' } })).toEqual({ ok: true });
    expect(await instances.mine('bo')).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready' });
    expect(await reporter.setup({ revision: 2, progress: { ...gitea, state: 'failed', why: 'pod gitea-0 is Init:Error' } })).toEqual({ ok: true });
    expect(await instances.mine('bo')).toMatchObject({ status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: pod gitea-0 is Init:Error' });
    expect(await reporter.status({ status: 'installing', detail: 'Running v1', imageTag: 'v1', revision: 2 })).toEqual({ ok: true });
    expect(await record()).toMatchObject({ status: 'failed', running: 'v1' });
    expect(await reporter.setup({ revision: 2, progress: setUp })).toEqual({ ok: true });
    expect(await instances.mine('bo')).toMatchObject({ status: 'ready', detail: 'Ready' });
    expect(handed).toEqual([]);
  });

  it('refuses a line that is not the setup\'s, saying why', async () => {
    const { reporter } = await root();
    expect(await reporter.setup({ revision: 1, progress: { stage: 'koala', title: 'Koala', state: 'done' } })).toEqual({ ok: false, status: 400, error: expect.stringContaining('is one of egress') as unknown });
  });
});
