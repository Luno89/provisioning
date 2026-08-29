import { describe, it, expect } from 'vitest';
import { PERSONA_SEEDS, RETIRED_PERSONAS } from './persona-seeds.js';
import { KOALA_NAME } from './koala-persona.js';
import { canRunLeaf } from './persona-scope.js';
import { validateScope } from './personas.js';

/**
 * The personas a user starts with.
 *
 * ── WHY THIS IS NOT COSMETIC ──
 * They lived inline in `scripts/seed-personas.ts` with a hardcoded owner id, so they were seeded by
 * hand for exactly one account. A new user got none — and a leaf with no persona has no environment,
 * so `acceptLeaf` refuses it. A fresh install could not accept a single piece of work.
 */

describe('the seeds themselves', () => {
  it('includes the ones work is actually assigned to', () => {
    const names = PERSONA_SEEDS.map((s) => s.name);
    for (const needed of ['Builder', 'Researcher', 'Reviewer']) {
      expect(names, needed).toContain(needed);
    }
  });

  it('has unique names, which is how everything looks them up', () => {
    // `resolvePersonaNamed` refuses an ambiguous match, so two seeds sharing a name would make
    // that name unusable rather than merely duplicated.
    const names = PERSONA_SEEDS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('seeds Koala, so a new user has it before ever opening a chat', () => {
    /**
     * It used to be created only by `ensureKoala`, on the chat path. So the Personas view of a
     * fresh account listed eight personas and no Koala, and the config drawer — asked for `koala`,
     * finding nothing — fell through `?? personas[0]` and offered Framer's prompt under Koala's
     * name.
     */
    expect(PERSONA_SEEDS.map((s) => s.name)).toContain(KOALA_NAME);
  });

  it('gives every chat-only seed an empty scope, which is what makes it chat-only', () => {
    /**
     * The reason a chat persona cannot take a leaf is that it carries no environment — no
     * toolchain, no repository, no egress. `acceptLeaf` reads exactly that through `canRunLeaf`,
     * so a chat seed that quietly gained a `language` would become assignable to work it cannot do.
     *
     * Asserted on the seed rather than on the name: the previous rule was `name === 'Koala'`, which
     * would have missed this the moment anyone renamed it.
     */
    const koala = PERSONA_SEEDS.find((s) => s.name === KOALA_NAME)!;
    expect(canRunLeaf(koala)).toBe(false);
  });

  it('gives every other seed an environment it can actually run in', () => {
    // The converse, and the reason the check is a capability: a work persona that declared nothing
    // would be refused at the gate with a message about being "for chat only".
    for (const seed of PERSONA_SEEDS.filter((s) => s.name !== KOALA_NAME)) {
      expect(canRunLeaf(seed), seed.name).toBe(true);
    }
  });

  it('has scopes that validate', () => {
    // A seed the API would reject is one nobody could edit and save back.
    for (const seed of PERSONA_SEEDS) {
      expect(validateScope(seed.scope), seed.name).toBeUndefined();
    }
  });

  it('seeds nothing that is retired', () => {
    // The retire list deletes by name; seeding one would recreate it on the next start.
    for (const seed of PERSONA_SEEDS) {
      expect(RETIRED_PERSONAS, seed.name).not.toContain(seed.name);
    }
  });
});

describe('how the runtime seeder differs from the script', () => {
  const here = new URL('../index.ts', import.meta.url);

  it('adds only what is missing, and never overwrites', async () => {
    /**
     * The script OVERWRITES, which is how a developer ships a change to a prompt. This must not:
     * reverting someone's edited persona every time they open the app is the same failure the
     * app-spec seeding avoids — they fix it, restart, and find it undone.
     */
    const src = await import('node:fs').then((fs) => fs.readFileSync(here, 'utf8'));
    const at = src.indexOf('async function ensurePersonas');
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/!mine\.some\(\(p\) => p\.name === seed\.name\)/);
    // No update path at all: if there is nothing missing it returns before writing anything.
    expect(body).toMatch(/if \(!missing\.length\) return;/);
  });
});
