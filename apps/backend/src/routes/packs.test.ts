import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { packsRouter } from './packs.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import { PersonaPackService } from '../services/PersonaPackService.js';
import { PACK_SEEDS } from '../lib/pack-seeds.js';

let harness: Harness;

const build = (db: Database) => packsRouter({
  db,
  packs: new PersonaPackService(db),
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
    await send('PUT', '/koala', { sampling: { toolTurn: { temperature: 0.05 } } });
    const { body } = await get();
    expect(body).toHaveLength(PACK_SEEDS.length);
    expect(body.find((p: any) => p.slug === 'koala').sampling.toolTurn.temperature).toBe(0.05);
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


  it('accepts an engine parameter the knob table does not model', async () => {
    // These were refused as "unknown setting" when they arrived as overrides. A pack's sampler
    // names its own engine's parameters, so refusing them would stop a pack describing its engine.
    const { status } = await send('POST', '', {
      slug: 'engine-knob', name: 'Engine', personaId: 'builtin-persona-koala',
      sampling: { toolTurn: { some_engine_knob: 1 }, conversation: {} },
    });
    expect(status).toBe(201);
  });

  it('refuses a pack value outside its declared range', async () => {
    const { status, body } = await send('POST', '', {
      slug: 'too-hot', name: 'Hot', personaId: 'builtin-persona-koala',
      sampling: { toolTurn: { temperature: 5 }, conversation: {} },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/temperature/i);
  });

  it('merges a partial edit rather than replacing the field', async () => {
    // The opposite of what the overrides bag did. A knob grid sends one knob, and everything it
    // does not name has to keep the value the pack already has — there is no layer underneath now.
    await send('PUT', '/koala', { sampling: { toolTurn: { temperature: 0.9, top_p: 0.5 } } });
    const after = await send('PUT', '/koala', { sampling: { toolTurn: { temperature: 0.8 } } });

    expect(after.body.sampling.toolTurn.temperature).toBe(0.8);
    expect(after.body.sampling.toolTurn.top_p).toBe(0.5);
  });

  it('accepts a model the user actually has, and refuses one they do not', async () => {
    const ok = await send('PUT', '/koala', { model: { endpointId: 'dep-1' } });
    expect(ok.status).toBe(200);
    const no = await send('PUT', '/koala', { model: { endpointId: 'someone-elses' } });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/no model someone-elses/i);
  });

  it('refuses to delete a built-in, since it is shared by everyone', async () => {
    const res = await send('DELETE', '/judge', {});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ships with the platform/i);
  });

  it('editing a built-in copies it to you and leaves the shipped row alone', async () => {
    const shipped = await get('/synthesist');
    expect(shipped.body.ownerId).toBeUndefined();

    await send('PUT', '/synthesist', { sampling: { toolTurn: { temperature: 0.42 } } });
    const mine = await get('/synthesist');
    expect(mine.body.ownerId).toBe(TEST_USER.id);
    expect(mine.body.id).not.toBe(shipped.body.id);
    expect(mine.body.sampling.toolTurn.temperature).toBe(0.42);

    const res = await send('DELETE', `/${mine.body.id}`, {});
    expect(res.status).toBe(200);
    const after = await get('/synthesist');
    expect(after.body.ownerId).toBeUndefined();
    expect(after.body.overrides).toEqual(shipped.body.overrides);
  });
});

/**
 * This is what the Lab's knob grid saves through: a partial pack, deep-merged into the row. It used
 * to take a bag of `overrides`, so after the layering went it still accepted that field, wrote it to
 * a pack that has no such field, and silently ignored the sampler and budget it was actually sent.
 */
describe('editing a pack\'s values', () => {
  const koalaId = 'koala';

  it('merges one sampler value without restating the rest of the pack', async () => {
    const { status, body } = await send('PUT', `/${koalaId}`, {
      sampling: { toolTurn: { temperature: 0.9 } },
    });

    expect(status).toBe(200);
    expect(body.sampling.toolTurn.temperature).toBe(0.9);
    expect(body.sampling.conversation.frequency_penalty).toBe(0.4);
    expect(body.budget.rounds).toBe(8);
  });

  it('merges a budget the same way, at whatever depth', async () => {
    const { body } = await send('PUT', `/${koalaId}`, { budget: { run: { steps: 42 } } });

    expect(body.budget.run.steps).toBe(42);
    expect(body.budget.run.tokens).toBe(1_000_000);
    expect(body.budget.rounds).toBe(8);
  });

  it('refuses a value outside the range its knob declares', async () => {
    const { status, body } = await send('PUT', `/${koalaId}`, {
      sampling: { toolTurn: { temperature: 5 } },
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/temperature/i);
  });

  it('lets a pack blank a prompt section, which is how one is turned off', async () => {
    const { body } = await send('PUT', `/${koalaId}`, { prompt: { sections: { secrets: '' } } });

    expect(body.prompt.sections.secrets).toBe('');
    expect(body.prompt.sections.toolGuidance).toBe('## Active Tools (each carries its own usage guidance — read it before calling)');
  });
});
