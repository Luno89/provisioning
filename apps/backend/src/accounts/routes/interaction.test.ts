import express from 'express';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { rootAuthOver } from '../../platform/testing/root-auth.js';
import { injectedFetch } from '../../platform/testing/injected-fetch.js';
import { openRoutesOf } from '../../open-routes.js';
import { principalFrom } from '../../platform/index.js';

async function world() {
  const db = memoryDatabase();
  const root = rootAuthOver(db, { open: openRoutesOf('root') });
  const app = express();
  app.use('/api', root.auth.requireAuth);
  root.mount(app);
  app.get('/api/who', (req, res) => { res.json(principalFrom(req)); });
  app.post('/api/stay-here', (req, res, next) => {
    root.revocations.revoked({ personId: principalFrom(req).id, because: 'password-or-2fa', at: new Date().toISOString(), kept: root.auth.keptSession(req) }).then(() => res.json({ ok: true }), next);
  });
  await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-01-01', roles: ['operator'] });
  const ask = (path: string, cookie: string, method = 'GET') => injectedFetch(app)(new URL(path, root.publicUrl), { method, headers: { cookie } });
  return { db, root, app, ask };
}

describe('signing in on root through root\'s own provider', () => {
  it('signs a person in with the form at the provider\'s interaction, and root\'s web app then holds their session with the claims root gives them', async () => {
    const { root, ask } = await world();
    const { cookie } = await root.signedIn('ann');
    const who = await ask('/api/who', cookie);
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ kind: 'person', id: 'ann', claims: [{ role: 'person' }, { role: 'operator' }] });
  });

  it('refuses a browser that never signed in', async () => {
    const { ask } = await world();
    expect((await ask('/api/who', 'koala_sid=s%3Anever.made')).status).toBe(401);
  });

  it('keeps the browser a change was made in signed in, and signs every other browser of that person out', async () => {
    const { root, ask } = await world();
    const here = await root.signedIn('ann');
    const there = await root.signedIn('ann');
    expect((await ask('/api/stay-here', here.cookie, 'POST')).status).toBe(200);
    expect((await ask('/api/who', here.cookie)).status).toBe(200);
    expect((await ask('/api/who', there.cookie)).status).toBe(401);
  });

  it('signs every browser of that person out when nothing is kept', async () => {
    const { root, ask } = await world();
    const here = await root.signedIn('ann');
    await root.revocations.revoked({ personId: 'ann', because: 'signed-out-everywhere', at: new Date().toISOString() });
    expect((await ask('/api/who', here.cookie)).status).toBe(401);
  });
});
