import { describe, it, expect } from 'vitest';
import { validatePack } from './packs.js';
import type { PersonaPack } from '@koala/harness-types';
import { PACK_SEEDS } from './pack-seeds.js';

const pack = (over: Partial<PersonaPack> = {}): PersonaPack => ({
  id: 'pk1', ownerId: 'u1', slug: 'koala', name: 'Koala',
  personaId: 'p1', tools: [],
  sampling: PACK_SEEDS[0]!.sampling, budget: PACK_SEEDS[0]!.budget, prompt: PACK_SEEDS[0]!.prompt, createdAt: '', updatedAt: '', ...over,
});

describe('validatePack', () => {
  const personas = [{ id: 'p1' }, { id: 'p2' }];

  it('refuses a persona that does not exist', () => {
    expect(validatePack({ slug: 'a', name: 'A', personaId: 'gone',  }, [], personas))
      .toMatch(/does not exist/i);
  });

  it('refuses a persona belonging to somebody else the same way as a missing one', () => {
    expect(validatePack({ slug: 'a', name: 'A', personaId: 'p9',  }, [], personas))
      .toMatch(/does not exist/i);
  });

  it('refuses a slug that could not survive a URL', () => {
    for (const slug of ['Has Spaces', 'UPPER', 'trailing-', 'sym$bol']) {
      expect(validatePack({ slug, name: 'A', personaId: 'p1',  }, [], personas), slug)
        .toMatch(/not a valid slug/i);
    }
  });

  it('refuses a duplicate slug, which is a route that cannot resolve', () => {
    const existing = [pack({ id: 'other', slug: 'koala' })];
    expect(validatePack({ slug: 'koala', name: 'A', personaId: 'p1',  }, existing, personas))
      .toMatch(/already have a pack/i);
  });

  it('lets a pack keep its own slug when edited', () => {
    const existing = [pack({ id: 'pk1', slug: 'koala' })];
    expect(validatePack({ slug: 'koala', name: 'A', personaId: 'p1',  }, existing, personas, 'pk1'))
      .toBeUndefined();
  });


});

