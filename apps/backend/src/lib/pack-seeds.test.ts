import { describe, it, expect } from 'vitest';
import { PACK_SEEDS, seedPacks, type PackSeedStore } from './pack-seeds.js';
import { PERSONA_SEEDS } from './persona-seeds.js';
import type { PersonaPack } from '@koala/harness-types';
import { KOALA_TOOLS } from './koala-tools.js';

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

  it('declares permissions honestly against the tools it grants', () => {
    const koala = PACK_SEEDS.find((p) => p.slug === 'koala')!;
    expect(koala.tools).toContain('deploy_project');
    expect(koala.permitted).toContain('write');
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

  it('gives work packs the sandbox executor, and Koala the assistant one', () => {
    expect(PACK_SEEDS.find((p) => p.slug === 'koala')!.toolset).toBe('assistant');
    expect(PACK_SEEDS.find((p) => p.slug === 'builder')!.toolset).toBe('sandbox');
  });

  it('starts each work pack as what its persona already declared', () => {
    for (const seed of PERSONA_SEEDS.filter((p) => p.name !== 'Koala')) {
      const pack = PACK_SEEDS.find((p) => p.personaName === seed.name)!;
      expect(pack.tools, seed.name).toEqual(seed.scope?.tools ?? []);
    }
  });
});

describe('seeding', () => {
  it('gives a new owner the shipped packs, resolved to their own persona ids', async () => {
    const personas = personasFor('u1');
    const s = store([], personas);
    const added = await seedPacks(s, 'u1', ids);

    expect(added).toBe(PACK_SEEDS.length);
    const koala = s.saved.find((p) => p.slug === 'koala')!;
    expect(koala.ownerId).toBe('u1');
    expect(koala.personaId).toBe(personas.find((p) => p.name === 'Koala')!.id);
  });

  it('adds only what is missing, and never overwrites', async () => {
    const s = store([], personasFor('u1'));
    await seedPacks(s, 'u1', ids);

    const edited = s.saved.find((p) => p.slug === 'koala')!;
    edited.overrides = { temperature: 0.1 };
    edited.tools = ['get_logs'];
    edited.name = 'My Koala';

    const added = await seedPacks(s, 'u1', ids);
    expect(added).toBe(0);
    const after = s.saved.find((p) => p.slug === 'koala')!;
    expect(after.overrides).toEqual({ temperature: 0.1 });
    expect(after.tools).toEqual(['get_logs']);
    expect(after.name).toBe('My Koala');
  });

  it('skips a pack whose persona does not exist rather than writing a dangling id', async () => {
    const s = store([], []);
    const added = await seedPacks(s, 'u1', ids);
    expect(added).toBe(0);
    expect(s.saved).toEqual([]);
  });

  it('does not hand one owner another owner\'s packs', async () => {
    const s = store([], [...personasFor('u1'), ...personasFor('u2').map((p) => ({ ...p, id: `${p.id}-u2` }))]);
    await seedPacks(s, 'u1', ids);
    await seedPacks(s, 'u2', ids);

    expect(s.saved.filter((p) => p.ownerId === 'u1')).toHaveLength(PACK_SEEDS.length);
    expect(s.saved.filter((p) => p.ownerId === 'u2')).toHaveLength(PACK_SEEDS.length);
    const u2 = s.saved.find((p) => p.ownerId === 'u2' && p.slug === 'koala')!;
    expect(u2.personaId).toMatch(/-u2$/);
  });
});
