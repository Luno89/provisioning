import { describe, it, expect } from 'vitest';
import { PACK_SEEDS, seedPacks, type PackSeedStore } from './pack-seeds.js';
import { PERSONA_SEEDS } from './persona-seeds.js';
import type { PersonaPack } from '@koala/harness-types';
import { KOALA_TOOLS } from './koala-tools.js';

/**
 * Packs are rows, not a `const REGISTRY`.
 *
 * ── WHY THAT MATTERS ENOUGH TO TEST ──
 * The registry held two packs while `ChatSurface` offered three, and the third — `researcher` —
 * had never existed, so choosing it threw out of `getPersonaPack` and returned a 500 with no
 * indication which list was wrong. Two lists describing one thing is the failure this codebase has
 * hit with leaf columns, cluster providers and tree types; a served catalogue is how the others
 * were fixed.
 */

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
    // A pack whose persona never gets created is a pack that refuses at runtime. Seeding skips it
    // rather than writing a dangling id, so this catches the typo at the point it is introduced.
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
    /**
     * The old pack said `workflow: 'propose-only'` while granting `deploy_project`,
     * `set_project_env` and `inject_secret_to_pod` — all declared `write`. Nothing read the field,
     * so the false claim cost nothing. It is enforced now, so a pack granting a write tool without
     * the `write` effect would refuse its own tools at runtime.
     */
    const koala = PACK_SEEDS.find((p) => p.slug === 'koala')!;
    expect(koala.tools).toContain('deploy_project');
    expect(koala.permitted).toContain('write');
  });

  it('grants every tool the assistant executor can actually dispatch', () => {
    /**
     * A grant naming a tool that does not exist is silently nothing — it neither appears in the
     * schema list nor raises anything, so the pack simply lacks a capability its record claims.
     * Checked against the real dispatch table, which `KoalaToolName` already ties to the schemas.
     */
    const koala = PACK_SEEDS.find((p) => p.slug === 'koala')!;
    const dispatchable = new Set(KOALA_TOOLS.map((t) => t.function.name as string));
    for (const name of koala.tools) {
      expect(dispatchable, name).toContain(name);
    }
    // Including the web tools, which reach the network through the backend rather than the sandbox.
    expect(koala.tools).toContain('web_search');
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
    // The id, not the name: a rename in the Personas view must not re-point the pack.
    expect(koala.personaId).toBe(personas.find((p) => p.name === 'Koala')!.id);
  });

  it('adds only what is missing, and never overwrites', async () => {
    /**
     * The rule `ensurePersonas` states and the reason it gives: reverting somebody's edited record
     * every time they open the app is a failure they cannot diagnose, because the fix is undone
     * silently. A pack is where the tuning lives, so this matters more here than anywhere.
     */
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
    // A pack pointing at nothing REFUSES at runtime now, instead of silently resolving to Koala.
    // Writing one during seeding would manufacture exactly that broken state.
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
    // Each owner's pack points at that owner's persona, never across the tenant boundary.
    const u2 = s.saved.find((p) => p.ownerId === 'u2' && p.slug === 'koala')!;
    expect(u2.personaId).toMatch(/-u2$/);
  });
});
