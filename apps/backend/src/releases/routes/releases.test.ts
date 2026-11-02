import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { OdooRelease } from '../lib/odoo-release.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { releasesRouter, type ReleasesRouterDeps } from './releases.js';

const project = { id: 'p1', name: 'Shop', ownerId: TEST_USER.id } as ProjectMetadata;
const release = (state: OdooRelease['state']): OdooRelease => ({ id: 'r1', ownerId: TEST_USER.id, projectId: 'p1', pipelineRunId: 'b1', commit: 'abc', image: 'i', state, host: 'h', startedAt: 't', updatedAt: 't' });

async function setUp() {
  const releases = mock<ReleasesRouterDeps['releases']>();
  const deps = mock<ReleasesRouterDeps>({ releases });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  const routes = await routesInProcess({ prefix: '/', router: () => releasesRouter(deps) });
  return { deps, releases, routes };
}

describe('a project\'s releases', () => {
  it('lists the releases of a project the person owns with their addresses and the roll back on offer, and nothing of one they do not', async () => {
    const { releases, routes } = await setUp();
    releases.list.calledWith(TEST_USER.id, 'p1').mockResolvedValue([release('live')]);
    releases.addresses.calledWith('p1').mockResolvedValue({ live: 'http://shop.localhost:8000' });
    releases.rollBackOffer.calledWith(TEST_USER.id, 'p1').mockResolvedValue({ from: 'r1', to: 'r0', commit: 'aaaaaaaaaa', liveSince: 't' });
    const listed = await routes.get('/p1/releases');
    expect(listed.status).toBe(200);
    expect(listed.data).toEqual({
      releases: [release('live')],
      addresses: { live: 'http://shop.localhost:8000' },
      rollBack: { from: 'r1', to: 'r0', commit: 'aaaaaaaaaa', liveSince: 't' },
    });
    const other = await routes.get('/p2/releases');
    expect([other.status, other.data]).toEqual([404, { error: 'Project not found' }]);
  });

  it('leaves the roll back out when none is on offer', async () => {
    const { releases, routes } = await setUp();
    releases.list.mockResolvedValue([]);
    releases.addresses.mockResolvedValue({});
    releases.rollBackOffer.mockResolvedValue(undefined);
    expect((await routes.get('/p1/releases')).data).toEqual({ releases: [], addresses: {} });
  });

  it('asks for the project\'s owner, not the signed-in person, when the project has one', async () => {
    const { deps, releases, routes } = await setUp();
    deps.getOwnedProject.calledWith('shared', any()).mockResolvedValue({ ...project, id: 'shared', ownerId: 'someone-else' });
    releases.list.mockResolvedValue([]);
    releases.addresses.mockResolvedValue({});
    releases.rollBackOffer.mockResolvedValue(undefined);
    await routes.get('/shared/releases');
    expect(releases.list).toHaveBeenCalledWith('someone-else', 'shared');
  });

  it('shows the sign-in its vault holds, never cached, and nothing of a project the person does not own', async () => {
    const { deps, routes } = await setUp();
    deps.signIns.calledWith(project).mockResolvedValue([{ login: 'admin', password: 'kept-in-the-vault', describe: 'The password of Odoo\'s admin user.' }]);
    const shown = await routes.get('/p1/sign-in');
    expect(shown.data).toEqual({ signIns: [{ login: 'admin', password: 'kept-in-the-vault', describe: 'The password of Odoo\'s admin user.' }] });
    expect(shown.headers['cache-control']).toBe('no-store');
    expect((await routes.get('/p2/sign-in')).status).toBe(404);
  });

  it('cuts a preview over or discards it, passing the person\'s confirmation, and says why when it cannot', async () => {
    const { releases, routes } = await setUp();
    releases.decide.calledWith(TEST_USER.id, 'r1', 'cutOver', false).mockResolvedValue(release('preview'));
    releases.decide.calledWith(TEST_USER.id, 'r1', 'discard', false).mockResolvedValue(release('preview'));
    releases.decide.calledWith(TEST_USER.id, 'losing', 'cutOver', false).mockResolvedValue({ status: 409, error: 'it would lose things', losing: ['the column shop_order.note is dropped'] });
    releases.decide.calledWith(TEST_USER.id, 'losing', 'cutOver', true).mockResolvedValue(release('preview'));
    releases.decide.calledWith(TEST_USER.id, 'live', 'discard', false).mockResolvedValue({ status: 409, error: 'the release is live, not waiting in preview' });
    expect((await routes.post('/p1/releases/r1/cut-over')).status).toBe(202);
    expect((await routes.post('/p1/releases/r1/discard')).data).toEqual({ release: release('preview') });
    const refused = await routes.post('/p1/releases/losing/cut-over');
    expect([refused.status, refused.data]).toEqual([409, { error: 'it would lose things', losing: ['the column shop_order.note is dropped'] }]);
    expect((await routes.post('/p1/releases/losing/cut-over', { confirm: true })).status).toBe(202);
    expect((await routes.post('/p1/releases/live/discard')).data).toEqual({ error: 'the release is live, not waiting in preview' });
    expect((await routes.post('/p2/releases/r1/cut-over')).status).toBe(404);
    expect((await routes.post('/p2/releases/r1/discard')).status).toBe(404);
  });

  it('runs a preview\'s browser tests again, and says why when it cannot', async () => {
    const { releases, routes } = await setUp();
    releases.retest.calledWith(TEST_USER.id, 'r1').mockResolvedValue(release('preview'));
    releases.retest.calledWith(TEST_USER.id, 'live').mockResolvedValue({ status: 409, error: 'the release is live, so it cannot be tested again' });
    expect((await routes.post('/p1/releases/r1/retest')).status).toBe(202);
    expect((await routes.post('/p1/releases/live/retest')).data).toEqual({ error: 'the release is live, so it cannot be tested again' });
    expect((await routes.post('/p2/releases/r1/retest')).status).toBe(404);
  });

  it('rolls a live release back, and says why when it cannot', async () => {
    const { releases, routes } = await setUp();
    releases.rollBack.calledWith(TEST_USER.id, project, 'r1').mockResolvedValue(release('live'));
    releases.rollBack.calledWith(TEST_USER.id, project, 'preview').mockResolvedValue({ status: 409, error: 'the release is preview, not live' });
    expect((await routes.post('/p1/releases/r1/roll-back')).status).toBe(202);
    const refused = await routes.post('/p1/releases/preview/roll-back');
    expect([refused.status, refused.data]).toEqual([409, { error: 'the release is preview, not live' }]);
    expect((await routes.post('/p2/releases/r1/roll-back')).status).toBe(404);
  });

  it('releases a build again, holds it when the service skips it, and refuses a project being deleted', async () => {
    const { deps, releases, routes } = await setUp();
    releases.releaseAgain.calledWith(TEST_USER.id, project, 'r1').mockResolvedValue({ ...release('preparing'), again: 'r1' });
    releases.releaseAgain.calledWith(TEST_USER.id, project, 'live').mockResolvedValue({ status: 409, error: 'the release is live, so its build cannot be released again' });
    releases.releaseAgain.calledWith(TEST_USER.id, project, 'held').mockResolvedValue({ skipped: 'held' });
    deps.getOwnedProject.calledWith('going', any()).mockResolvedValue({ ...project, id: 'going', removal: { startedAt: 't' } } as ProjectMetadata);
    const again = await routes.post('/p1/releases/r1/again');
    expect([again.status, again.data]).toEqual([202, { release: { ...release('preparing'), again: 'r1' } }]);
    expect((await routes.post('/p1/releases/live/again')).data).toEqual({ error: 'the release is live, so its build cannot be released again' });
    const held = await routes.post('/p1/releases/held/again');
    expect([held.status, held.data]).toEqual([409, { error: 'held' }]);
    const going = await routes.post('/going/releases/r1/again');
    expect([going.status, going.data]).toEqual([409, { error: 'This project is being deleted' }]);
    expect((await routes.post('/p2/releases/r1/again')).status).toBe(404);
  });

  it('lists the files a release changes, and nothing of a release it does not have', async () => {
    const { releases, routes } = await setUp();
    const found = { against: { releaseId: 'r0', commit: 'aaa', state: 'live' as const }, files: [] };
    releases.files.calledWith(TEST_USER.id, project, 'r1').mockResolvedValue(found);
    releases.files.calledWith(TEST_USER.id, project, 'zz').mockResolvedValue({ status: 404, error: 'This project has no release with that id' });
    expect((await routes.get('/p1/releases/r1/files')).data).toEqual(found);
    expect((await routes.get('/p1/releases/zz/files')).status).toBe(404);
    expect((await routes.get('/p2/releases/r1/files')).status).toBe(404);
  });
});
