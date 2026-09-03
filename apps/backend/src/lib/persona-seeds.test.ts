import { describe, it, expect } from 'vitest';
import { PERSONA_SEEDS, RETIRED_PERSONAS, seedPersonas } from './persona-seeds.js';
import { KOALA_NAME } from './koala-persona.js';
import { canRunLeaf } from './persona-scope.js';
import { PACK_SEEDS } from './pack-seeds.js';
import { toolsNeeding } from './tool-registry.js';

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

  /**
   * Derived from the catalogue rather than from a list of exempt names.
   *
   * This used to say "every pack except koala", exempting the chat pack by name. Adding the
   * planner — which also has no sandbox, on purpose — would have meant a second name in the
   * exemption. The real invariant is about tools: a pack that can run a shell needs somewhere to
   * run it, and a pack that cannot must not be handed a sandbox it would only be tempted by.
   */
  const sandboxTools = new Set(toolsNeeding('sandbox'));
  const runsSandboxWork = (pack: { tools: string[] }) =>
    pack.tools.some((t) => sandboxTools.has(t));

  it('gives a workspace to every pack whose tools need one', () => {
    for (const pack of PACK_SEEDS.filter(runsSandboxWork)) {
      expect(canRunLeaf(pack as never), pack.slug).toBe(true);
    }
  });

  it('keeps the chat and planning packs out of a sandbox', () => {
    for (const slug of ['koala', 'planner']) {
      const pack = PACK_SEEDS.find((p) => p.slug === slug)!;
      expect(runsSandboxWork(pack), slug).toBe(false);
      expect(canRunLeaf(pack as never), slug).toBe(false);
    }
  });

  it('seeds nothing that is retired', () => {
    for (const seed of PERSONA_SEEDS) {
      expect(RETIRED_PERSONAS, seed.name).not.toContain(seed.name);
    }
  });
});

describe('seeding never destroys a customisation', () => {
  it('wipes and rewrites built-ins, but leaves a user-owned row alone', async () => {
    const saved: any[] = [];
    const store = {
      getPersonas: async () => saved,
      savePersona: async (p: any) => {
        const k = saved.findIndex((x) => x.id === p.id);
        if (k >= 0) saved[k] = p; else saved.push(p);
      },
      deletePersona: async (id: string) => {
        const k = saved.findIndex((x) => x.id === id);
        if (k >= 0) saved.splice(k, 1);
      },
    };

    await seedPersonas(store);
    const shipped = saved.length;
    expect(shipped).toBe(PERSONA_SEEDS.length);

    // Add a user-owned row — this must survive the next seed.
    saved.push({ id: 'mine', ownerId: 'u1', name: 'Koala', systemPrompt: 'my own', createdAt: '', updatedAt: '' });

    await seedPersonas(store);
    const mine = saved.find((p) => p.id === 'mine');
    expect(mine?.systemPrompt).toBe('my own');
    expect(saved.filter((p) => p.ownerId != null)).toHaveLength(1);
    expect(saved.filter((p) => p.ownerId == null)).toHaveLength(shipped);
  });
});