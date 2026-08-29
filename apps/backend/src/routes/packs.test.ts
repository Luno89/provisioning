import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { packsRouter } from './packs.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import { PACK_SEEDS } from '../lib/pack-seeds.js';

let harness: Harness;

const build = (db: Database) => packsRouter({
  db,
  modelIdsFor: async () => ['dep-1'],
  ensurePersonas: async (userId: string) => {
    const { PERSONA_SEEDS } = await import('../lib/persona-seeds.js');
    const mine = (await db.getPersonas()).filter((p) => p.ownerId === userId);
    const now = new Date().toISOString();
    for (const seed of PERSONA_SEEDS) {
      if (mine.some((p) => p.name === seed.name)) continue;
      await db.savePersona({ id: `persona-${seed.name}`, ownerId: userId, ...seed, createdAt: now, updatedAt: now } as never);
    }
  },
});

beforeAll(async () => { harness = await mountRouter({ prefix: '/api/packs', router: build }); });
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
    expect(koala.personaId).toBe('persona-Koala');
    expect(koala.ownerId).toBe(TEST_USER.id);
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
    expect(researcher.toolset).toBe('sandbox');
    expect(researcher.tools).toContain('web_search');
  });
});

describe('writing a pack', () => {
  it('refuses a persona that does not exist', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'ghost', name: 'Ghost', personaId: 'nope', toolset: 'assistant',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/persona does not exist/i);
  });

  it('refuses a duplicate slug, which is a route that cannot resolve', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'koala', name: 'Another', personaId: 'persona-Koala', toolset: 'assistant',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/already have a pack/i);
  });

  it('refuses an effect the action gate would not recognise', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'typo', name: 'Typo', personaId: 'persona-Koala', toolset: 'assistant',
      permitted: ['read', 'wrtie'],
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not an effect/i);
  });

  it('refuses an override the registry does not know', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'bad-knob', name: 'Bad', personaId: 'persona-Koala', toolset: 'assistant',
      overrides: { temprature: 0.5 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown setting/i);
  });

  it('refuses an override outside its declared range', async () => {
    const { status } = await send('POST', '', {
      slug: 'too-hot', name: 'Hot', personaId: 'persona-Koala', toolset: 'assistant',
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

  it('re-seeds a deleted built-in, so deleting one means resetting it', async () => {
    await send('DELETE', '/koala', {});
    const gone = await get('/koala');
    expect(gone.status).toBe(404);
    const { body } = await get();
    const koala = body.find((p: any) => p.slug === 'koala');
    expect(koala).toBeDefined();
    expect(koala.overrides).toEqual({ temperature: 0.7 });
  });
});
