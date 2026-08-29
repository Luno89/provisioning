import { describe, it, expect } from 'vitest';
import { PERSONA_SEEDS, RETIRED_PERSONAS, seedPersonas } from './persona-seeds.js';
import { KOALA_NAME } from './koala-persona.js';
import { canRunLeaf } from './persona-scope.js';
import { PACK_SEEDS } from './pack-seeds.js';
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

  it('gives the chat pack no workspace, which is what makes it chat-only', () => {
    const koala = PACK_SEEDS.find((p) => p.slug === 'koala')!;
    expect(canRunLeaf(koala as never)).toBe(false);
  });

  it('gives every work pack an environment it can actually run in', () => {
    for (const pack of PACK_SEEDS.filter((p) => p.slug !== 'koala')) {
      expect(canRunLeaf(pack as never), pack.slug).toBe(true);
    }
  });

  it('has workspaces that validate', () => {
    for (const pack of PACK_SEEDS) {
      expect(validateScope(pack.workspace), pack.slug).toBeUndefined();
    }
  });

  it('seeds nothing that is retired', () => {
    for (const seed of PERSONA_SEEDS) {
      expect(RETIRED_PERSONAS, seed.name).not.toContain(seed.name);
    }
  });
});

describe('seeding never destroys a customisation', () => {
  it('leaves a row somebody owns alone, and refreshes one nobody has touched', async () => {
    const saved: any[] = [];
    const store = {
      getPersonas: async () => saved,
      savePersona: async (p: any) => {
        const k = saved.findIndex((x) => x.id === p.id);
        if (k >= 0) saved[k] = p; else saved.push(p);
      },
    };

    await seedPersonas(store);
    const shipped = saved.length;
    expect(shipped).toBe(PERSONA_SEEDS.length);
    expect(saved.every((p) => p.ownerId === undefined)).toBe(true);

    saved.push({ id: 'mine', ownerId: 'u1', name: 'Koala', systemPrompt: 'my own', createdAt: '', updatedAt: '' });
    const builtIn = saved.find((p) => p.ownerId === undefined && p.name === 'Koala')!;
    builtIn.systemPrompt = 'stale';

    await seedPersonas(store);
    expect(saved.find((p) => p.id === 'mine')!.systemPrompt).toBe('my own');
    expect(saved.find((p) => p.ownerId === undefined && p.name === 'Koala')!.systemPrompt).not.toBe('stale');
    expect(saved.filter((p) => p.ownerId === undefined)).toHaveLength(shipped);
  });
});
