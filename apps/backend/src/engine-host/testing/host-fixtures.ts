import type { HostNodeServices } from '../nodes/services.js';
import type { ImageBuilder } from '../sandboxes/image-builder.js';

export const READY_IMAGES: ImageBuilder = {
  ensure: async (plan) => plan.base,
  exists: async () => true,
  start: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
  standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
};

export const TEST_MODELS = {
  resolveBaseUrl: async () => ({
    provider: { id: 'bucket-1', name: 'Test', source: 'deployment', model: 'test-model', contextTokens: 32_000 } as never,
    baseUrl: 'https://models.test/v1',
    apiKey: 'k',
  }),
};

export const NO_MEMORIES: HostNodeServices['memories'] = {
  list: async () => [],
  save: async () => undefined,
  unindex: async () => undefined,
};
