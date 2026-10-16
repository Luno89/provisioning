import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import { runningRouter } from './running.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const quiet = { validateStatus: () => true };

describe('/api/running', () => {
  it('shows, cancels and pauses as the signed-in person, and says why it cannot', async () => {
    const asked: string[] = [];
    h = await mountRouter({
      prefix: '/api/running',
      router: () => runningRouter({ running: {
        view: async (ownerId) => { asked.push(`view ${ownerId}`); return { ok: true, value: { items: [], bench: { paused: false }, keeper: { paused: false, held: 0 } } }; },
        cancel: async (ownerId, id) => { asked.push(`cancel ${ownerId} ${id}`); return id === 'gone' ? { ok: false, status: 404, error: 'Nothing of yours is running under that id' } : { ok: true, value: { cancelling: true } }; },
        pauseBench: async (ownerId, body) => { asked.push(`bench ${ownerId} ${JSON.stringify(body)}`); return { ok: true, value: { paused: true } }; },
        pauseKeeper: async (ownerId, body) => { asked.push(`keeper ${ownerId} ${JSON.stringify(body)}`); return { ok: true, value: { paused: true, held: 0 } }; },
      } }),
    });
    expect((await axios.get(h.url('/api/running'))).data).toEqual({ items: [], bench: { paused: false }, keeper: { paused: false, held: 0 } });
    expect((await axios.post(h.url('/api/running/run-1/cancel'), {})).status).toBe(202);
    expect((await axios.post(h.url('/api/running/gone/cancel'), {}, quiet)).data).toEqual({ error: 'Nothing of yours is running under that id' });
    await axios.put(h.url('/api/running/bench'), { paused: true });
    await axios.put(h.url('/api/running/keeper'), { paused: true });
    expect(asked).toEqual([`view ${TEST_USER.id}`, `cancel ${TEST_USER.id} run-1`, `cancel ${TEST_USER.id} gone`, `bench ${TEST_USER.id} {"paused":true}`, `keeper ${TEST_USER.id} {"paused":true}`]);
  });
});
