import { BaseService } from './BaseService.js';
import type { Persona, PersonaPack } from '@koala/harness-types';
import { withBuiltIns } from '../lib/ownership.js';

export class PersonaPackService extends BaseService {
  /** All packs visible to a user: built-ins plus the user's own overrides. */
  async visiblePacks(userId: string): Promise<PersonaPack[]> {
    return withBuiltIns(await this.db.getPersonaPacks(), userId, (p) => p.slug);
  }

  /** Resolve a pack by id or slug, visible to the user. */
  async resolvePack(userId: string, id: string): Promise<PersonaPack | undefined> {
    const packs = await this.visiblePacks(userId);
    return packs.find((p) => p.id === id || p.slug === id);
  }

  /** All personas visible to a user: built-ins plus the user's own overrides. */
  async visiblePersonas(userId: string): Promise<Persona[]> {
    return withBuiltIns(await this.db.getPersonas(), userId, (p) => p.name);
  }

  async resolvePersona(userId: string, personaId: string): Promise<Persona | undefined> {
    const personas = await this.visiblePersonas(userId);
    const found = personas.find((p) => p.id === personaId);
    if (found) return found;
    const all = await this.db.getPersonas();
    const original = all.find((p) => p.id === personaId);
    if (!original) return undefined;
    return personas.find((p) => p.name === original.name);
  }
}