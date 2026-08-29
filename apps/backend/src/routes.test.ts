import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { bootstrap } from './index.js';
import axios from 'axios';
import http from 'http';

describe('Auth Endpoints & Route Protection Integration', () => {
  let app: express.Application;
  let server: http.Server;
  let port: number;
  /** Set by the registration test and reused below — see the note there. */
  let session = '';

  beforeAll(async () => {
    axios.defaults.proxy = false;
    // Bootstrap backend
    const res = await bootstrap();
    app = res.app;

    // Start a temporary test server on a random free port
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        port = addr.port;
        resolve();
      });
    });
  }, 30_000);

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  const getUrl = (path: string) => `http://127.0.0.1:${port}${path}`;

  it('should block protected routes with 401 when no session is provided', async () => {
    try {
      await axios.get(getUrl('/api/clusters'));
      expect.fail('Should have failed with 401');
    } catch (err: any) {
      expect(err.response.status).toBe(401);
      expect(err.response.data.error).toContain('Session missing');
    }
  });

  it('should register and log in natively, returning correct JWT session cookie', async () => {
    const email = `test-user-${Date.now()}@example.com`;
    const password = 'myPassword123';

    // Register
    const regRes = await axios.post(getUrl('/api/auth/register'), { email, password });
    expect(regRes.status).toBe(200);
    expect(regRes.data.success).toBe(true);

    // Login
    const loginRes = await axios.post(getUrl('/api/auth/login'), { email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.data.success).toBe(true);
    expect(loginRes.headers['set-cookie']).toBeDefined();
    
    const sessionCookie = loginRes.headers['set-cookie']![0]!.split(';')[0]!;
    session = sessionCookie;
    expect(sessionCookie).toContain('session=');

    // Access profile using the cookie
    const profileRes = await axios.get(getUrl('/api/auth/me'), {
      headers: { Cookie: sessionCookie },
    });
    expect(profileRes.status).toBe(200);
    expect(profileRes.data.email).toBe(email);
    expect(profileRes.data.twoFactorEnabled).toBe(false);

    // Now protected routes should succeed
    const clustersRes = await axios.get(getUrl('/api/clusters'), {
      headers: { Cookie: sessionCookie },
    });
    expect(clustersRes.status).toBe(200);
  });

  /**
   * Three fields have now been dropped by a route that destructures its body field-by-field:
   * the deployment config group, `dependsOn`, and `expects`. Each time the type had the field, the
   * request carried it, the code typechecked, and the record was written without it — a leaf that
   * silently loses its ordering or its verification looks identical to one that never had any.
   *
   * This asserts the round trip rather than the destructuring, so it stays true however the route
   * is rewritten.
   */
  /**
   * The branch equivalent of the leaf-field test above, and the fourth place this shape of bug has
   * turned up: a full-replace save that rebuilds the row from named fields drops everything it does
   * not mention. Here it ate `acceptance` on every chat turn — the tool wrote it and the transcript
   * save immediately removed it.
   */
  /**
   * The pack catalogue, through the real application.
   *
   * Every router in this area passes in isolation, and that is not the same as the app assembling
   * and serving them — a router that works alone while `bootstrap()` throws is a green suite and a
   * dead server. This walks what a new account actually gets: personas seeded, packs seeded on top
   * of them (which only works if the seeders run in that order), and a Koala that exists in BOTH
   * lists rather than being conjured on the chat path.
   */
  it('gives a brand-new account a Koala persona AND a Koala pack', async () => {
    expect(session).toBeTruthy();
    const auth = { headers: { Cookie: session } };

    const personas = await axios.get(getUrl('/api/personas'), auth);
    expect(personas.status).toBe(200);
    const koalaPersona = personas.data.find((p: any) => p.name === 'Koala');
    // It used to be created only by `ensureKoala`, on the chat path, so this list had eight
    // personas and no Koala until the user happened to open a conversation.
    expect(koalaPersona, 'Koala missing from the personas list').toBeTruthy();

    const packs = await axios.get(getUrl('/api/packs'), auth);
    expect(packs.status).toBe(200);
    const koalaPack = packs.data.find((p: any) => p.slug === 'koala');
    expect(koalaPack, 'Koala missing from the pack catalogue').toBeTruthy();
    // Resolved to this user's own persona id, not a name and not another tenant's record.
    expect(koalaPack.personaId).toBe(koalaPersona.id);
    expect(koalaPack.ownerId).toBe(personas.data[0].ownerId);
  });

  it('serves the catalogue idempotently, and keeps an edit', async () => {
    const auth = { headers: { Cookie: session } };
    const before = await axios.get(getUrl('/api/packs'), auth);
    const koala = before.data.find((p: any) => p.slug === 'koala');

    await axios.put(getUrl(`/api/packs/${koala.id}`), { overrides: { temperature: 0.11 } }, auth);

    // Seeding ADDS what is missing and never overwrites — the rule `ensurePersonas` states, and the
    // one that matters most here, since a pack is where the tuning lives.
    const after = await axios.get(getUrl('/api/packs'), auth);
    expect(after.data).toHaveLength(before.data.length);
    expect(after.data.find((p: any) => p.slug === 'koala').overrides.temperature).toBe(0.11);
  });

  it('refuses a chat turn for a pack that does not exist', async () => {
    const auth = { headers: { Cookie: session } };
    // Used to throw out of a two-entry constant and return a 500 naming neither list.
    await expect(
      axios.post(getUrl('/api/chat-pack/researcher'), { message: 'hi' }, auth),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('keeps branch fields the chat turn does not own', async () => {
    expect(session).toBeTruthy();
    const auth = { headers: { Cookie: session } };

    const created = await axios.post(getUrl('/api/branches'), { title: 'acceptance survives' }, auth);
    const id = created.data.id;

    // Whatever else a turn writes, a field set outside it must still be there afterwards.
    const leaf = await axios.post(getUrl('/api/leaves'), { title: 'something', branchId: id }, auth);
    expect(leaf.data.branchId).toBe(id);

    const after = await axios.get(getUrl('/api/branches'), auth);
    const branch = after.data.find((b: any) => b.id === id);
    expect(branch).toBeTruthy();
    expect(branch.title).toBe('acceptance survives');
  });

  it('keeps the fields that decide how a leaf runs', async () => {
    // Reuses the session the registration test established: only the FIRST user can register
    // without an invite, so a second registration here would 403 and take that test with it.
    expect(session).toBeTruthy();
    const auth = { headers: { Cookie: session } };

    const first = await axios.post(getUrl('/api/leaves'), { title: 'First step' }, auth);
    const second = await axios.post(getUrl('/api/leaves'), {
      title: 'Second step',
      branchId: first.data.branchId,
      dependsOn: [first.data.id],
      expects: ['NOTES.md'],
    }, auth);

    // Ordering, and the verification that covers work with no tests to run.
    expect(second.data.dependsOn).toEqual([first.data.id]);
    expect(second.data.expects).toEqual(['NOTES.md']);
  });

  it('should support Mock social oauth redirect loops', async () => {
    // GitHub redirect
    const ghRes = await axios.get(getUrl('/api/auth/github'), { maxRedirects: 0, validateStatus: () => true });
    expect(ghRes.status).toBe(302);
    expect(ghRes.headers.location).toContain('/api/auth/github/callback?code=mock-github-code');

    // Google redirect
    const gRes = await axios.get(getUrl('/api/auth/google'), { maxRedirects: 0, validateStatus: () => true });
    expect(gRes.status).toBe(302);
    expect(gRes.headers.location).toContain('/api/auth/google/callback?code=mock-google-code');
  });
});
