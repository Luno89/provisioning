import { describe, it, expect } from 'vitest';
import { PACK_SEEDS, seedPacks, packForLeaf, type PackSeedStore } from './pack-seeds.js';
import { PERSONA_SEEDS } from './persona-seeds.js';
import type { PersonaPack } from '@koala/harness-types';
import { ALL_TOOL_SEEDS } from './tool-seeds.js';
import { TOOL_HANDLERS } from './tool-registry.js';
import { schemasFor } from './tool-catalogue.js';

const KOALA_TOOLS = schemasFor(ALL_TOOL_SEEDS, PACK_SEEDS.find((p) => p.slug === 'koala')!.tools);

const store = (personas: { id: string; name: string }[]): PackSeedStore & { saved: PersonaPack[] } => {
  const saved: PersonaPack[] = [];
  return {
    saved,
    getPersonaPacks: async () => saved,
    savePersonaPack: async (p) => {
      const i = saved.findIndex((x) => x.id === p.id);
      if (i >= 0) saved[i] = p; else saved.push(p);
    },
    deletePersonaPack: async (id) => {
      const i = saved.findIndex((x) => x.id === id);
      if (i >= 0) saved.splice(i, 1);
    },
    getPersonas: async () => personas,
  };
};

const builtInPersonas = PERSONA_SEEDS.map((p, i) => ({ id: `bp${i}`, name: p.name }));

describe('the seeds themselves', () => {
  it('names a persona that is actually seeded', () => {
    const seeded = new Set(PERSONA_SEEDS.map((s) => s.name));
    for (const pack of PACK_SEEDS) {
      expect(seeded, pack.slug).toContain(pack.personaName);
    }
  });

  it('has unique slugs', () => {
    const slugs = PACK_SEEDS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('still gives the chat pack the web', () => {
    expect(PACK_SEEDS.find((p) => p.slug === 'koala')!.tools).toContain('web_search');
    expect(KOALA_TOOLS.map((t) => t.function.name)).toContain('web_search');
  });

  /**
   * The guardrail that was missing.
   *
   * This used to check only the shipped koala pack against the assistant surface, so an EDITED
   * pack -- the kind a person actually makes -- was checked by nothing. One granted seventeen
   * planning tools to a chat, which offered them to the model and then answered `No tool named
   * "get_leaf"` for every call. There is one dispatcher now, so the question is simply whether the
   * name is a tool at all, and that is a question every pack can be asked.
   */
  it('grants only names that are tools', () => {
    const catalogue = new Set(ALL_TOOL_SEEDS.map((t) => t.name));
    for (const pack of PACK_SEEDS) {
      for (const name of pack.tools) {
        expect(TOOL_HANDLERS, `${pack.slug} grants ${name}, which nothing implements`)
          .toHaveProperty(name);
        expect(catalogue, `${pack.slug} grants ${name}, which is not in the catalogue`)
          .toContain(name);
      }
    }
  });
});

describe('every persona has a pack to run as', () => {
  it('ships one pack per seeded persona', () => {
    const packed = new Set(PACK_SEEDS.map((p) => p.personaName));
    for (const persona of PERSONA_SEEDS) {
      expect(packed, persona.name).toContain(persona.name);
    }
  });
});

describe('seeding', () => {
  it('wipes old built-ins and writes fresh rows', async () => {
    const s = store(builtInPersonas);
    expect(await seedPacks(s)).toBe(PACK_SEEDS.length);
    expect(s.saved.every((p) => p.ownerId === undefined)).toBe(true);
    expect(s.saved.every((p) => p.builtIn === true)).toBe(true);
  });

  /**
   * This asserted the opposite — that seeding rewrote every built-in on every run — which
   * contradicted `seed-all.test.ts`'s "writes nothing on a second run" and moved each pack's
   * `updatedAt`. `ranAs.packUpdatedAt` records that timestamp to say which configuration a run
   * used, so rewriting made every past run look as though its pack had since been edited.
   */
  it('writes nothing on a second run, leaving the rows and their timestamps alone', async () => {
    const s = store(builtInPersonas);
    expect(await seedPacks(s)).toBe(PACK_SEEDS.length);
    const stamps = s.saved.map((p) => p.updatedAt);

    expect(await seedPacks(s)).toBe(0);
    expect(s.saved).toHaveLength(PACK_SEEDS.length);
    expect(s.saved.map((p) => p.updatedAt)).toEqual(stamps);
  });

  it('brings a built-in that drifted from its seed back into line', async () => {
    const s = store(builtInPersonas);
    await seedPacks(s);
    const drifted = s.saved.find((p) => p.ownerId == null)!;
    drifted.tools = ['nothing_like_the_seed'];

    expect(await seedPacks(s)).toBe(1);
    expect(s.saved.find((p) => p.id === drifted.id)!.tools).not.toEqual(['nothing_like_the_seed']);
  });

  it('never touches a row somebody owns', async () => {
    const s = store(builtInPersonas);
    await seedPacks(s);
    s.saved.push({
      id: 'mine', ownerId: 'u1', slug: 'koala', name: 'My Koala', personaId: 'bp0', tools: ['get_logs'],
      sampling: { ...PACK_SEEDS[0]!.sampling, toolTurn: { ...PACK_SEEDS[0]!.sampling.toolTurn, temperature: 0.1 } },
      budget: PACK_SEEDS[0]!.budget, prompt: PACK_SEEDS[0]!.prompt,
      createdAt: '', updatedAt: '',
    } as PersonaPack);
    await seedPacks(s);
    const mine = s.saved.find((p) => p.id === 'mine')!;
    expect(mine.tools).toEqual(['get_logs']);
    expect(mine.sampling.toolTurn.temperature).toBe(0.1);
  });

  it('skips packs whose persona does not exist', async () => {
    const s = store([]);
    expect(await seedPacks(s)).toBe(0);
    expect(s.saved).toEqual([]);
  });

  it('gives a built-in a stable id across restarts', async () => {
    const a = store(builtInPersonas);
    await seedPacks(a);
    const b = store(builtInPersonas);
    await seedPacks(b);
    expect(a.saved.map((p) => p.id)).toEqual(b.saved.map((p) => p.id));
  });
});

describe('packForLeaf', () => {
  const pack = (over: Partial<PersonaPack> = {}): PersonaPack => ({
    id: 'pk1', ownerId: 'u1', slug: 'koala', name: 'Koala', personaId: 'p1', tools: [],
    sampling: PACK_SEEDS[0]!.sampling, budget: PACK_SEEDS[0]!.budget, prompt: PACK_SEEDS[0]!.prompt,
    createdAt: '', updatedAt: '', ...over,
  });
  const koala = pack({ id: 'pk-koala', slug: 'koala' });
  const builder = pack({ id: 'pk-builder', slug: 'builder' });
  const packs = [koala, builder];

  it('uses the pack a leaf names, by id or by slug', () => {
    expect(packForLeaf(packs, { packId: 'pk-builder' })).toBe(builder);
    expect(packForLeaf(packs, { packId: 'builder' })).toBe(builder);
  });

  it('falls back to the profile\'s packId when the leaf names none', () => {
    expect(packForLeaf(packs, {}, 'pk-koala')).toBe(koala);
  });

  it('prefers the leaf\'s own packId over the profile\'s', () => {
    expect(packForLeaf(packs, { packId: 'builder' }, 'pk-koala')).toBe(builder);
  });

  it('returns nothing rather than guessing', () => {
    expect(packForLeaf(packs, {})).toBeUndefined();
    expect(packForLeaf(packs, { packId: 'gone' }, 'also-gone')).toBeUndefined();
  });
});