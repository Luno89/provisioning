import { createSandboxDriver } from '../drivers/sandbox.js';
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
  index: async () => undefined,
  unindex: async () => undefined,
  search: async () => [],
  markedProjects: async () => [],
};

const noIndex = (): never => { throw new Error('nothing here keeps a memory index'); };

export const NO_MEMORY_INDEX: Pick<HostNodeServices['memories'], 'index' | 'unindex' | 'search'> = { index: async () => noIndex(), unindex: async () => noIndex(), search: async () => noIndex() };

export function sandboxDriverFor({ id, spec }: { id: string; spec: Parameters<typeof createSandboxDriver>[0]['spec'] }) {
  return createSandboxDriver({
    sandboxId: id,
    spec,
    backend: {
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      readFile: async () => '',
      writeFile: async () => undefined,
      listDir: async () => [],
      deleteFile: async () => undefined,
    },
  });
}
