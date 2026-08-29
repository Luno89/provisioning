import { describe, it, expect } from 'vitest';
import { PERSONA_SEEDS, RETIRED_PERSONAS } from './persona-seeds.js';
import { KOALA_NAME } from './koala-persona.js';
import { canRunLeaf } from './persona-scope.js';
import { validateScope } from './personas.js';

describe('the seeds themselves', () => {
  it('includes the ones work is actually assigned to', () => {
    const names = PERSONA_SEEDS.map((s) => s.name);
    for (const needed of ['Builder', 'Researcher', 'Reviewer']) {
      expect(names, needed).toContain(needed);
    }
  });

  it('has unique names, which is how everything looks them up', () => {
    const names = PERSONA_SEEDS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('seeds Koala, so a new user has it before ever opening a chat', () => {
    expect(PERSONA_SEEDS.map((s) => s.name)).toContain(KOALA_NAME);
  });

  it('gives every chat-only seed an empty scope, which is what makes it chat-only', () => {
    const koala = PERSONA_SEEDS.find((s) => s.name === KOALA_NAME)!;
    expect(canRunLeaf(koala)).toBe(false);
  });

  it('gives every other seed an environment it can actually run in', () => {
    for (const seed of PERSONA_SEEDS.filter((s) => s.name !== KOALA_NAME)) {
      expect(canRunLeaf(seed), seed.name).toBe(true);
    }
  });

  it('has scopes that validate', () => {
    for (const seed of PERSONA_SEEDS) {
      expect(validateScope(seed.scope), seed.name).toBeUndefined();
    }
  });

  it('seeds nothing that is retired', () => {
    for (const seed of PERSONA_SEEDS) {
      expect(RETIRED_PERSONAS, seed.name).not.toContain(seed.name);
    }
  });
});

describe('how the runtime seeder differs from the script', () => {
  const here = new URL('../index.ts', import.meta.url);

  it('adds only what is missing, and never overwrites', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(here, 'utf8'));
    const at = src.indexOf('async function ensurePersonas');
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/!mine\.some\(\(p\) => p\.name === seed\.name\)/);
    expect(body).toMatch(/if \(!missing\.length\) return;/);
  });
});
