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
    decide: async (_ownerId: string, releaseId: string, decision: 'cutOver' | 'discard') => {
      if (state !== 'preview') return { status: 409, error: `the release is ${state}, not waiting in preview` };
      decided.push(`${decision} ${releaseId}`);
      return { id: releaseId } as never;
    },
  };
  const getOwnedProject = async (id: string, user: { id: string }) => (id === 'p1' ? { id, ownerId: user.id } : undefined);
  return { decided, mounted: mountRouter({ prefix: '/api/projects', router: () => releasesRouter({ releases, getOwnedProject }) }) };
}

describe('a project\'s releases', () => {
  it('lists the releases of a project the person owns, and nothing of one they do not', async () => {
    const { mounted } = harness('live');
    const h = await mounted;
    expect((await axios.get(h.url('/api/projects/p1/releases'))).data).toEqual({
      releases: [{ id: 'r1', ownerId: TEST_USER.id, projectId: 'p1', state: 'live' }],
      addresses: { live: 'http://shop.localhost:8000', preview: 'http://shop-preview.localhost:8000' },
    });
    expect((await axios.get(h.url('/api/projects/p2/releases'), quiet)).status).toBe(404);
    await h.close();
  });

  it('cuts a preview over or discards it, and says why when it cannot', async () => {
    const waiting = harness('preview');
    const h = await waiting.mounted;
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/cut-over'), {}, quiet)).status).toBe(202);
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/discard'), {}, quiet)).status).toBe(202);
    expect(waiting.decided).toEqual(['cutOver r1', 'discard r1']);
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/cut-over'), {}, quiet)).status).toBe(404);
    await h.close();

    const live = harness('live');
    const h2 = await live.mounted;
    expect((await axios.post(h2.url('/api/projects/p1/releases/r1/cut-over'), {}, quiet)).data).toEqual({ error: 'the release is live, not waiting in preview' });
    await h2.close();
  });
});
