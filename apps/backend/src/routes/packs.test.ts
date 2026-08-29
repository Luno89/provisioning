import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { packsRouter } from './packs.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import { PACK_SEEDS } from '../lib/pack-seeds.js';

let harness: Harness;

const build = (db: Database) => packsRouter({
  db,
  modelIdsFor: async () => ['dep-1'],
});

beforeAll(async () => {
  harness = await mountRouter({ prefix: '/api/packs', router: build });
  const { PERSONA_SEEDS, seedPersonas } = await import('../lib/persona-seeds.js');
  const { seedPacks } = await import('../lib/pack-seeds.js');
  void PERSONA_SEEDS;
  await seedPersonas(harness.db);
  await seedPacks(harness.db);
});
afterAll(async () => { await harness.close(); });

const get = (path = ''): Promise<{ status: number; body: any }> =>
  fetch(harness.url(`/api/packs${path}`)).then(async (r) => ({ status: r.status, body: await r.json() }));
const send = (method: string, path: string, body: unknown): Promise<{ status: number; body: any }> =>
  fetch(harness.url(`/api/packs${path}`), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('GET /api/packs', () => {
  it('seeds and serves a working catalogue on first read', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toHaveLength(PACK_SEEDS.length);
    const koala = body.find((p: any) => p.slug === 'koala');
    expect(koala.name).toBe('Koala');
    expect(koala.personaId).toBe('builtin-persona-koala');
    expect(koala.ownerId, 'a shipped pack belongs to the platform, not a person').toBeUndefined();
    expect(koala.builtIn).toBe(true);
  });

  it('is idempotent — reading twice does not duplicate or revert', async () => {
    await send('PUT', '/koala', { overrides: { temperature: 0.05 } });
    const { body } = await get();
    expect(body).toHaveLength(PACK_SEEDS.length);
    expect(body.find((p: any) => p.slug === 'koala').overrides).toEqual({ temperature: 0.05 });
  });

  it('resolves a pack by slug as well as by id, because the slug is the URL', async () => {
    const bySlug = await get('/koala');
    expect(bySlug.status).toBe(200);
    const byId = await get(`/${bySlug.body.id}`);
    expect(byId.body.id).toBe(bySlug.body.id);
  });

  it('404s an unknown pack rather than substituting one', async () => {
    const { status } = await get('/no-such-pack');
    expect(status).toBe(404);
  });

  it('serves a pack for every seeded persona, so a leaf always has one to run as', async () => {
    const { body } = await get();
    const slugs = body.map((p: any) => p.slug);
    expect(slugs).toContain('koala');
    expect(slugs).toContain('researcher');
    expect(slugs).toContain('builder');

    const researcher = body.find((p: any) => p.slug === 'researcher');
    expect(researcher.tools).toContain('web_search');
  });
});

describe('writing a pack', () => {
  it('refuses a persona that does not exist', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'ghost', name: 'Ghost', personaId: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/persona does not exist/i);
  });

  it('refuses a duplicate slug, which is a route that cannot resolve', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'koala', name: 'Another', personaId: 'builtin-persona-koala',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/already have a pack/i);
  });


  it('refuses an override the registry does not know', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'bad-knob', name: 'Bad', personaId: 'builtin-persona-koala',
      overrides: { temprature: 0.5 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown setting/i);
  });

  it('refuses an override outside its declared range', async () => {
    const { status } = await send('POST', '', {
      slug: 'too-hot', name: 'Hot', personaId: 'builtin-persona-koala',
      overrides: { temperature: 5 },
    });
    expect(status).toBe(400);
  });

  it('replaces the overrides bag rather than merging it', async () => {
    await send('PUT', '/koala', { overrides: { temperature: 0.9, top_p: 0.5 } });
    const after = await send('PUT', '/koala', { overrides: { temperature: 0.9 } });
    expect(after.body.overrides).toEqual({ temperature: 0.9 });
  });

  it('accepts a model the user actually has, and refuses one they do not', async () => {
    const ok = await send('PUT', '/koala', { overrides: { model: 'dep-1' } });
    expect(ok.status).toBe(200);
    const no = await send('PUT', '/koala', { overrides: { model: 'someone-elses' } });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/must be one of your models/i);
  });

  it('refuses to delete a built-in, since it is shared by everyone', async () => {
    const res = await send('DELETE', '/judge', {});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ships with the platform/i);
  });

  it('editing a built-in copies it to you and leaves the shipped row alone', async () => {
    const shipped = await get('/synthesist');
    expect(shipped.body.ownerId).toBeUndefined();

    await send('PUT', '/synthesist', { overrides: { temperature: 0.42 } });
    const mine = await get('/synthesist');
    expect(mine.body.ownerId).toBe(TEST_USER.id);
    expect(mine.body.id).not.toBe(shipped.body.id);
    expect(mine.body.overrides.temperature).toBe(0.42);

    const res = await send('DELETE', `/${mine.body.id}`, {});
    expect(res.status).toBe(200);
    const after = await get('/synthesist');
    expect(after.body.ownerId).toBeUndefined();
    expect(after.body.overrides).toEqual(shipped.body.overrides);
  });
});
