import type { Persona } from '@koala/agent-engine';

export interface StoredPersonas {
  getEnginePersonas(ownerId?: string): Promise<Persona[]>;
  deleteEnginePersona(ownerId: string | undefined, slug: string): Promise<void>;
}

export async function retireStoredBuiltInPersonas(store: StoredPersonas): Promise<number> {
  const builtIn = (await store.getEnginePersonas()).filter((row) => row.ownerId === undefined);
  for (const row of builtIn) await store.deleteEnginePersona(undefined, row.slug);
  return builtIn.length;
}
