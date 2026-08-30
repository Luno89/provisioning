import { describe, it, expect } from 'vitest';
import { PACK_SEEDS, seedPacks, type PackSeedStore } from './pack-seeds.js';
import { PERSONA_SEEDS } from './persona-seeds.js';
import type { PersonaPack } from '@koala/harness-types';
import { ALL_TOOL_SEEDS } from './tool-seeds.js';
import { forSurface } from './tool-catalogue.js';

const KOALA_TOOLS = forSurface(ALL_TOOL_SEEDS, 'assistant');

const store = (packs: PersonaPack[], personas: { id: string; ownerId: string; name: string }[]): PackSeedStore & { saved: PersonaPack[] } => {
  const saved = [...packs];
  return {
    saved,
    getPersonaPacks: async () => saved,
    savePersonaPack: async (p) => {
      const i = saved.findIndex((x) => x.id === p.id);
      if (i >= 0) saved[i] = p; else saved.push(p);
    },
    getPersonas: async () => personas,
  };
};

const personasFor = (ownerId: string) =>
  PERSONA_SEEDS.map((s, i) => ({ id: `p${i}`, ownerId, name: s.name }));

let n = 0;
const ids = () => `pack-${++n}`;

describe('the seeds themselves', () => {
  it('names a persona that is actually seeded', () => {
    const seeded = new Set(PERSONA_SEEDS.map((s) => s.name));
    for (const pack of PACK_SEEDS) {
      expect(seeded, pack.slug).toContain(pack.personaName);
    }
  });

  it('has unique slugs, which is what the URL and the seeder both match on', () => {
    const slugs = PACK_SEEDS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('grants every tool the assistant executor can actually dispatch', () => {
    const koala = PACK_SEEDS.find((p) => p.slug === 'koala')!;
    const dispatchable = new Set(KOALA_TOOLS.map((t) => t.function.name as string));
    for (const name of koala.tools) {
      expect(dispatchable, name).toContain(name);
    }
    expect(koala.tools).toContain('web_search');
  });
});

describe('every persona has a pack to run as', () => {
  it('ships one pack per seeded persona', () => {
    const packed = new Set(PACK_SEEDS.map((p) => p.personaName));
    for (const persona of PERSONA_SEEDS) {
      expect(packed, persona.name).toContain(persona.name);
    }
  });

  it('starts each work pack as what its persona already declared', () => {
    for (const seed of PERSONA_SEEDS.filter((p) => p.name !== 'Koala')) {
      const pack = PACK_SEEDS.find((p) => p.personaName === seed.name)!;
      expect(pack.tools, seed.name).toBeDefined();
    }
  });
});

describe('seeding', () => {
  const shipped = (personas: { id: string; name: string }[]) => {
    const saved: PersonaPack[] = [];
    return {
      saved,
      getPersonaPacks: async () => saved,
      savePersonaPack: async (p: PersonaPack) => {
        const k = saved.findIndex((x) => x.id === p.id);
        if (k >= 0) saved[k] = p; else saved.push(p);
      },
      getPersonas: async () => personas,
    };
  };
  const builtInPersonas = PERSONA_SEEDS.map((p, i) => ({ id: `bp${i}`, name: p.name }));

  it('writes one ownerless row per shipped pack', async () => {
    const s = shipped(builtInPersonas);
    expect(await seedPacks(s)).toBe(PACK_SEEDS.length);
    expect(s.saved.every((p) => p.ownerId === undefined)).toBe(true);
    expect(s.saved.every((p) => p.builtIn === true)).toBe(true);
  });

  it('writes nothing on a second run when nothing shipped has changed', async () => {
    const s = shipped(builtInPersonas);
    await seedPacks(s);
    expect(await seedPacks(s)).toBe(0);
    expect(s.saved).toHaveLength(PACK_SEEDS.length);
  });

  it('updates a shipped pack nobody has customised', async () => {
    const s = shipped(builtInPersonas);
    await seedPacks(s);
    const koala = s.saved.find((p) => p.slug === 'koala')!;
    koala.tools = ['stale'];
    expect(await seedPacks(s)).toBe(1);
    expect(s.saved.find((p) => p.slug === 'koala')!.tools).not.toEqual(['stale']);
  });

  it('never touches a row somebody owns', async () => {
    const s = shipped(builtInPersonas);
    await seedPacks(s);
    s.saved.push({
      id: 'mine', ownerId: 'u1', slug: 'koala', name: 'My Koala', personaId: 'bp0', tools: ['get_logs'], sampling: PACK_SEEDS[0]!.sampling, budget: PACK_SEEDS[0]!.budget, overrides: { temperature: 0.1 },
      createdAt: '', updatedAt: '',
    } as PersonaPack);
    await seedPacks(s);
    const mine = s.saved.find((p) => p.id === 'mine')!;
    expect(mine.tools).toEqual(['get_logs']);
    expect(mine.overrides).toEqual({ temperature: 0.1 });
  });

  it('skips a pack whose persona does not exist rather than writing a dangling id', async () => {
    const s = shipped([]);
    expect(await seedPacks(s)).toBe(0);
    expect(s.saved).toEqual([]);
  });

  it('gives a built-in a stable id, so a reference survives a restart', async () => {
    const a = shipped(builtInPersonas);
    await seedPacks(a);
    const b = shipped(builtInPersonas);
    await seedPacks(b);
    expect(a.saved.map((p) => p.id)).toEqual(b.saved.map((p) => p.id));
  });
});
