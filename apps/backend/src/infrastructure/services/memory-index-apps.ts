import type { InfrastructureStore } from '../store.js';

export const MEMORY_INDEX_APPS_MIGRATION = 'memory-index-apps-go';

const RETIRED_APP_SPECS = new Set(['qdrant', 'quickwit', 'tei']);
const RETIRED_BINDING_TYPES = new Set(['qdrant', 'quickwit', 'embeddings']);

export async function removeMemoryIndexApps(store: Pick<InfrastructureStore, 'getAppSpecs' | 'deleteAppSpec' | 'getBindingTypes' | 'deleteBindingType'>): Promise<Record<string, number>> {
  const specs = (await store.getAppSpecs()).filter((spec) => RETIRED_APP_SPECS.has(spec.id));
  for (const spec of specs) await store.deleteAppSpec(spec.id);
  const types = (await store.getBindingTypes()).filter((type) => RETIRED_BINDING_TYPES.has(type.id));
  for (const type of types) await store.deleteBindingType(type.id);
  return { appSpecs: specs.length, bindingTypes: types.length };
}
