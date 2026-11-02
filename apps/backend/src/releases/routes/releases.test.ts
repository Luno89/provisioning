import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { OdooRelease } from '../lib/odoo-release.js';
import { dispatch, SIGNED_IN } from '../testing/dispatch.js';
import { releasesRouter, type ReleasesRouterDeps } from './releases.js';

const project = { id: 'p1', name: 'Shop', ownerId: SIGNED_IN.id } as ProjectMetadata;
const release = (state: OdooRelease['state']): OdooRelease => ({ id: 'r1', ownerId: SIGNED_IN.id, projectId: 'p1', pipelineRunId: 'b1', commit: 'abc', image: 'i', state, host: 'h', startedAt: 't', updatedAt: 't' });

function setUp() {
  const releases = mock<ReleasesRouterDeps['releases']>();
  const deps = mock<ReleasesRouterDeps>({ releases });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  return { deps, releases, router: releasesRouter(deps) };
}

const get = (router: ReturnType<typeof releasesRouter>, url: string) => dispatch(router, { method: 'GET', url });
const post = (router: ReturnType<typeof releasesRouter>, url: string, json: unknown = {}) => dispatch(router, { method: 'POST', url, json });

describe('a project\'s releases', () => {
  it('lists the releases of a project the person owns with their addresses and the roll back on offer, and nothing of one they do not', async () => {
    const { releases, router } = setUp();
    releases.list.calledWith(SIGNED_IN.id, 'p1').mockResolvedValue([release('live')]);
    releases.addresses.calledWith('p1').mockResolvedValue({ live: 'http://shop.localhost:8000' });
    releases.rollBackOffer.calledWith(SIGNED_IN.id, 'p1').mockResolvedValue({ from: 'r1', to: 'r0', commit: 'aaaaaaaaaa', liveSince: 't' });
    const listed = await get(router, '/p1/releases');
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({
      releases: [release('live')],
      addresses: { live: 'http://shop.localhost:8000' },
      rollBack: { from: 'r1', to: 'r0', commit: 'aaaaaaaaaa', liveSince: 't' },
    });
    const other = await get(router, '/p2/releases');
    expect([other.status, other.json]).toEqual([404, { error: 'Project not found' }]);
  });

  it('leaves the roll back out when none is on offer', async () => {
    const { releases, router } = setUp();
    releases.list.mockResolvedValue([]);
    releases.addresses.mockResolvedValue({});
    releases.rollBackOffer.mockResolvedValue(undefined);
    expect((await get(router, '/p1/releases')).json).toEqual({ releases: [], addresses: {} });
  });

  it('asks for the project\'s owner, not the signed-in person, when the project has one', async () => {
    const { deps, releases, router } = setUp();
    deps.getOwnedProject.calledWith('shared', any()).mockResolvedValue({ ...project, id: 'shared', ownerId: 'someone-else' });
    releases.list.mockResolvedValue([]);
    releases.addresses.mockResolvedValue({});
    releases.rollBackOffer.mockResolvedValue(undefined);
    await get(router, '/shared/releases');
    expect(releases.list).toHaveBeenCalledWith('someone-else', 'shared');
  });

  it('shows the sign-in its vault holds, never cached, and nothing of a project the person does not own', async () => {
    const { deps, router } = setUp();
    deps.signIns.calledWith(project).mockResolvedValue([{ login: 'admin', password: 'kept-in-the-vault', describe: 'The password of Odoo\'s admin user.' }]);
    const shown = await get(router, '/p1/sign-in');
    expect(shown.json).toEqual({ signIns: [{ login: 'admin', password: 'kept-in-the-vault', describe: 'The password of Odoo\'s admin user.' }] });
    expect(shown.headers['cache-control']).toBe('no-store');
    expect((await get(router, '/p2/sign-in')).status).toBe(404);
  });

  it('cuts a preview over or discards it, passing the person\'s confirmation, and says why when it cannot', async () => {
    const { releases, router } = setUp();
    releases.decide.calledWith(SIGNED_IN.id, 'r1', 'cutOver', false).mockResolvedValue(release('preview'));
    releases.decide.calledWith(SIGNED_IN.id, 'r1', 'discard', false).mockResolvedValue(release('preview'));
    releases.decide.calledWith(SIGNED_IN.id, 'losing', 'cutOver', false).mockResolvedValue({ status: 409, error: 'it would lose things', losing: ['the column shop_order.note is dropped'] });
    releases.decide.calledWith(SIGNED_IN.id, 'losing', 'cutOver', true).mockResolvedValue(release('preview'));
    releases.decide.calledWith(SIGNED_IN.id, 'live', 'discard', false).mockResolvedValue({ status: 409, error: 'the release is live, not waiting in preview' });
    expect((await post(router, '/p1/releases/r1/cut-over')).status).toBe(202);
    expect((await post(router, '/p1/releases/r1/discard')).json).toEqual({ release: release('preview') });
    const refused = await post(router, '/p1/releases/losing/cut-over');
    expect([refused.status, refused.json]).toEqual([409, { error: 'it would lose things', losing: ['the column shop_order.note is dropped'] }]);
    expect((await post(router, '/p1/releases/losing/cut-over', { confirm: true })).status).toBe(202);
    expect((await post(router, '/p1/releases/live/discard')).json).toEqual({ error: 'the release is live, not waiting in preview' });
    expect((await post(router, '/p2/releases/r1/cut-over')).status).toBe(404);
    expect((await post(router, '/p2/releases/r1/discard')).status).toBe(404);
  });

  it('runs a preview\'s browser tests again, and says why when it cannot', async () => {
    const { releases, router } = setUp();
    releases.retest.calledWith(SIGNED_IN.id, 'r1').mockResolvedValue(release('preview'));
    releases.retest.calledWith(SIGNED_IN.id, 'live').mockResolvedValue({ status: 409, error: 'the release is live, so it cannot be tested again' });
    expect((await post(router, '/p1/releases/r1/retest')).status).toBe(202);
    expect((await post(router, '/p1/releases/live/retest')).json).toEqual({ error: 'the release is live, so it cannot be tested again' });
    expect((await post(router, '/p2/releases/r1/retest')).status).toBe(404);
  });

  it('rolls a live release back, and says why when it cannot', async () => {
    const { releases, router } = setUp();
    releases.rollBack.calledWith(SIGNED_IN.id, project, 'r1').mockResolvedValue(release('live'));
    releases.rollBack.calledWith(SIGNED_IN.id, project, 'preview').mockResolvedValue({ status: 409, error: 'the release is preview, not live' });
    expect((await post(router, '/p1/releases/r1/roll-back')).status).toBe(202);
    const refused = await post(router, '/p1/releases/preview/roll-back');
    expect([refused.status, refused.json]).toEqual([409, { error: 'the release is preview, not live' }]);
    expect((await post(router, '/p2/releases/r1/roll-back')).status).toBe(404);
  });

  it('releases a build again, holds it when the service skips it, and refuses a project being deleted', async () => {
    const { deps, releases, router } = setUp();
    releases.releaseAgain.calledWith(SIGNED_IN.id, project, 'r1').mockResolvedValue({ ...release('preparing'), again: 'r1' });
    releases.releaseAgain.calledWith(SIGNED_IN.id, project, 'live').mockResolvedValue({ status: 409, error: 'the release is live, so its build cannot be released again' });
    releases.releaseAgain.calledWith(SIGNED_IN.id, project, 'held').mockResolvedValue({ skipped: 'held' });
    deps.getOwnedProject.calledWith('going', any()).mockResolvedValue({ ...project, id: 'going', removal: { startedAt: 't' } } as ProjectMetadata);
    const again = await post(router, '/p1/releases/r1/again');
    expect([again.status, again.json]).toEqual([202, { release: { ...release('preparing'), again: 'r1' } }]);
    expect((await post(router, '/p1/releases/live/again')).json).toEqual({ error: 'the release is live, so its build cannot be released again' });
    const held = await post(router, '/p1/releases/held/again');
    expect([held.status, held.json]).toEqual([409, { error: 'held' }]);
    const going = await post(router, '/going/releases/r1/again');
    expect([going.status, going.json]).toEqual([409, { error: 'This project is being deleted' }]);
    expect((await post(router, '/p2/releases/r1/again')).status).toBe(404);
  });

  it('lists the files a release changes, and nothing of a release it does not have', async () => {
    const { releases, router } = setUp();
    const found = { against: { releaseId: 'r0', commit: 'aaa', state: 'live' as const }, files: [] };
    releases.files.calledWith(SIGNED_IN.id, project, 'r1').mockResolvedValue(found);
    releases.files.calledWith(SIGNED_IN.id, project, 'zz').mockResolvedValue({ status: 404, error: 'This project has no release with that id' });
    expect((await get(router, '/p1/releases/r1/files')).json).toEqual(found);
    expect((await get(router, '/p1/releases/zz/files')).status).toBe(404);
    expect((await get(router, '/p2/releases/r1/files')).status).toBe(404);
  });
});
