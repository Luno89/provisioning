import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from './test-harness.js';
import { releasesRouter } from './releases.js';

const quiet = { validateStatus: () => true };

function harness(state: string) {
  const decided: string[] = [];
  const releases = {
    list: async (ownerId: string, projectId: string) => [{ id: 'r1', ownerId, projectId, state }] as never,
    addresses: async () => ({ live: 'http://shop.localhost:8000', preview: 'http://shop-preview.localhost:8000' }),
    decide: async (_ownerId: string, releaseId: string, decision: 'cutOver' | 'discard', confirmed?: boolean) => {
      if (state !== 'preview') return { status: 409, error: `the release is ${state}, not waiting in preview` };
      if (state === 'preview' && decision === 'cutOver' && releaseId === 'losing' && !confirmed) return { status: 409, error: 'it would lose things', losing: ['the column shop_order.note is dropped'] };
      decided.push(`${decision} ${releaseId}${confirmed ? ' confirmed' : ''}`);
      return { id: releaseId } as never;
    },
    rollBackOffer: async () => (state === 'live' ? { from: 'r1', to: 'r0', commit: 'aaaaaaaaaa', liveSince: '2026-10-09T12:00:00Z' } : undefined),
    rollBack: async (_ownerId: string, project: { id: string }, releaseId: string) => {
      if (state !== 'live') return { status: 409, error: `the release is ${state}, not live` };
      decided.push(`rollBack ${project.id} ${releaseId}`);
      return { id: releaseId } as never;
    },
    releaseAgain: async (_ownerId: string, project: { id: string }, releaseId: string) => {
      if (state === 'live') return { status: 409, error: 'the release is live, so its build cannot be released again' };
      if (state === 'same') return { skipped: 'held' };
      decided.push(`again ${project.id} ${releaseId}`);
      return { id: 'r2', again: releaseId } as never;
    },
    files: async (_ownerId: string, project: { id: string }, releaseId: string) => (releaseId === 'r1'
      ? { against: { releaseId: 'r0', commit: 'aaa', state: 'live' as const }, files: [{ path: 'addons/x.py', status: 'modified' as const, added: 1, removed: 0, binary: false, patch: 'p', inApp: true }] }
      : { status: 404, error: `${project.id} has no release ${releaseId}` }),
    retest: async (_ownerId: string, releaseId: string) => {
      if (state !== 'preview') return { status: 409, error: `the release is ${state}, so its browser tests cannot run again` };
      decided.push(`retest ${releaseId}`);
      return { id: releaseId } as never;
    },
  };
  const getOwnedProject = async (id: string, user: { id: string }) => (id === 'p1' ? { id, ownerId: user.id } as never : undefined);
  return { decided, mounted: mountRouter({ prefix: '/api/projects', router: () => releasesRouter({ releases, getOwnedProject, signIns: async (project) => (project.id === 'p1' ? [{ login: 'admin', password: 'kept-in-the-vault', describe: 'The password of Odoo\'s admin user.' }] : []) }) }) };
}

describe('a project\'s releases', () => {
  it('lists the releases of a project the person owns, and nothing of one they do not', async () => {
    const { mounted } = harness('live');
    const h = await mounted;
    expect((await axios.get(h.url('/api/projects/p1/releases'))).data).toEqual({
      releases: [{ id: 'r1', ownerId: TEST_USER.id, projectId: 'p1', state: 'live' }],
      addresses: { live: 'http://shop.localhost:8000', preview: 'http://shop-preview.localhost:8000' },
      rollBack: { from: 'r1', to: 'r0', commit: 'aaaaaaaaaa', liveSince: '2026-10-09T12:00:00Z' },
    });
    expect((await axios.get(h.url('/api/projects/p2/releases'), quiet)).status).toBe(404);
    await h.close();
  });

  it('shows the sign-in its vault holds, uncached, and nothing of a project the person does not own', async () => {
    const h = await harness('live').mounted;
    const shown = await axios.get(h.url('/api/projects/p1/sign-in'));
    expect(shown.data).toEqual({ signIns: [{ login: 'admin', password: 'kept-in-the-vault', describe: 'The password of Odoo\'s admin user.' }] });
    expect(shown.headers['cache-control']).toBe('no-store');
    expect((await axios.get(h.url('/api/projects/p2/sign-in'), { validateStatus: () => true })).status).toBe(404);
  });

  it('cuts a preview over or discards it, and says why when it cannot', async () => {
    const waiting = harness('preview');
    const h = await waiting.mounted;
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/cut-over'), {}, quiet)).status).toBe(202);
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/discard'), {}, quiet)).status).toBe(202);
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/retest'), {}, quiet)).status).toBe(202);
    expect(waiting.decided).toEqual(['cutOver r1', 'discard r1', 'retest r1']);
    expect((await axios.post(h.url('/api/projects/p1/releases/losing/cut-over'), {}, quiet)).data).toEqual({ error: 'it would lose things', losing: ['the column shop_order.note is dropped'] });
    expect((await axios.post(h.url('/api/projects/p1/releases/losing/cut-over'), { confirm: true }, quiet)).status).toBe(202);
    expect(waiting.decided.at(-1)).toBe('cutOver losing confirmed');
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/retest'), {}, quiet)).status).toBe(404);
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/cut-over'), {}, quiet)).status).toBe(404);
    await h.close();

    const live = harness('live');
    const h2 = await live.mounted;
    expect((await axios.post(h2.url('/api/projects/p1/releases/r1/cut-over'), {}, quiet)).data).toEqual({ error: 'the release is live, not waiting in preview' });
    expect((await axios.post(h2.url('/api/projects/p1/releases/r1/retest'), {}, quiet)).data).toEqual({ error: 'the release is live, so its browser tests cannot run again' });
    await h2.close();
  });

  it('rolls a live release back, and says why when it cannot', async () => {
    const live = harness('live');
    const h = await live.mounted;
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/roll-back'), {}, quiet)).status).toBe(202);
    expect(live.decided).toEqual(['rollBack p1 r1']);
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/roll-back'), {}, quiet)).status).toBe(404);
    await h.close();

    const waiting = harness('preview');
    const h2 = await waiting.mounted;
    const refused = await axios.post(h2.url('/api/projects/p1/releases/r1/roll-back'), {}, quiet);
    expect([refused.status, refused.data]).toEqual([409, { error: 'the release is preview, not live' }]);
    expect((await axios.get(h2.url('/api/projects/p1/releases'))).data).not.toHaveProperty('rollBack');
    await h2.close();
  });

  it('releases a build again, and says why when it cannot', async () => {
    const ok = harness('discarded');
    const h = await ok.mounted;
    const again = await axios.post(h.url('/api/projects/p1/releases/r1/again'), {}, quiet);
    expect([again.status, again.data]).toEqual([202, { release: { id: 'r2', again: 'r1' } }]);
    expect(ok.decided).toEqual(['again p1 r1']);
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/again'), {}, quiet)).status).toBe(404);
    await h.close();
    const live = await harness('live').mounted;
    expect((await axios.post(live.url('/api/projects/p1/releases/r1/again'), {}, quiet)).data).toEqual({ error: 'the release is live, so its build cannot be released again' });
    await live.close();
    const held = await harness('same').mounted;
    expect((await axios.post(held.url('/api/projects/p1/releases/r1/again'), {}, quiet)).data).toEqual({ error: 'held' });
    await held.close();
  });

  it('lists the files a release changes, and nothing of a release it does not have', async () => {
    const h = await harness('preview').mounted;
    expect((await axios.get(h.url('/api/projects/p1/releases/r1/files'))).data).toMatchObject({ against: { releaseId: 'r0' }, files: [{ path: 'addons/x.py', inApp: true }] });
    expect((await axios.get(h.url('/api/projects/p1/releases/zz/files'), quiet)).status).toBe(404);
    expect((await axios.get(h.url('/api/projects/p2/releases/r1/files'), quiet)).status).toBe(404);
    await h.close();
  });
});
