import { describe, it, expect } from 'vitest';
import { ModelService } from './ModelService.js';
import { MemoryDB } from '../lib/memory-db.js';
import type { ModelEndpointMetadata, UserMetadata } from '../lib/types.js';

/**
 * An account that registers a gateway gets one endpoint row PER MODEL — an OpenRouter key is
 * several hundred. That is the case the account default exists for: with more than one endpoint
 * `resolveBaseUrl` has nothing to fall back on, so every pack naming no engine fails outright.
 */
const gatewayEndpoints = (ownerId: string, count: number): ModelEndpointMetadata[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `openrouter-${i}`,
    ownerId,
    name: `OpenRouter · vendor/model-${i}`,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: `vendor/model-${i}`,
    createdAt: new Date().toISOString(),
  }));

const build = async (endpoints: ModelEndpointMetadata[], user?: Partial<UserMetadata>) => {
  const db = new MemoryDB();
  await db.init();
  for (const e of endpoints) await db.saveModelEndpoint(e);
  await db.saveUser({
    id: 'u1', email: 'u@example.com', emailVerified: true,
    createdAt: new Date().toISOString(), ...user,
  } as UserMetadata);

  const apps = { getAll: async () => [] } as never;
  const stub = {} as never;
  return new ModelService(db as never, apps, stub, stub, stub, 'master-key');
};

describe('the engine a run reaches', () => {
  it('refuses to guess among many endpoints when nothing names one', async () => {
    const models = await build(gatewayEndpoints('u1', 425));
    await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/425 endpoints and nothing named one/);
  });

  it('names all three settings that would fix it, so the message is actionable', async () => {
    const models = await build(gatewayEndpoints('u1', 425));
    await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/default model for the account/);
    await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/model\.endpointId/);
  });

  it('runs on the account default when the pack names no engine', async () => {
    const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
    const resolved = await models.resolveBaseUrl('u1');
    expect(resolved.provider.id).toBe('openrouter-7');
    expect(resolved.source).toBe('global');
    expect(resolved.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it("lets the pack's own engine beat the account default", async () => {
    const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
    const resolved = await models.resolveBaseUrl('u1', undefined, 'openrouter-3');
    expect(resolved.provider.id).toBe('openrouter-3');
    expect(resolved.source).toBe('pack');
  });

  it('lets an explicit request beat both', async () => {
    const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
    const resolved = await models.resolveBaseUrl('u1', 'openrouter-1', 'openrouter-3');
    expect(resolved.provider.id).toBe('openrouter-1');
    expect(resolved.source).toBe('request');
  });

  it('treats a cleared pack endpoint as naming nothing, not as an id to look up', async () => {
    const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
    const resolved = await models.resolveBaseUrl('u1', undefined, null);
    expect(resolved.provider.id).toBe('openrouter-7');
    expect(resolved.source).toBe('global');
  });

  it('honours the account override, so a pinned pack runs on the default too', async () => {
    const models = await build(gatewayEndpoints('u1', 425), {
      defaultModelId: 'openrouter-7', globalModelOverride: true,
    });
    const resolved = await models.resolveBaseUrl('u1', undefined, 'openrouter-3');
    expect(resolved.provider.id).toBe('openrouter-7');
    expect(resolved.source).toBe('global');
  });

  it('puts the pack back on its own engine when the override is off', async () => {
    const models = await build(gatewayEndpoints('u1', 425), {
      defaultModelId: 'openrouter-7', globalModelOverride: false,
    });
    const resolved = await models.resolveBaseUrl('u1', undefined, 'openrouter-3');
    expect(resolved.provider.id).toBe('openrouter-3');
    expect(resolved.source).toBe('pack');
  });

  it('still runs a sole endpoint that nothing names, and says so', async () => {
    const models = await build(gatewayEndpoints('u1', 1));
    const resolved = await models.resolveBaseUrl('u1');
    expect(resolved.provider.id).toBe('openrouter-0');
    expect(resolved.source).toBe('sole');
  });

  it('errors rather than falling back to the default when a named endpoint is gone', async () => {
    const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
    await expect(models.resolveBaseUrl('u1', undefined, 'deleted')).rejects.toThrow(/Model deleted not found/);
  });

  it('does not reach another tenant\'s endpoint through the default', async () => {
    const models = await build(gatewayEndpoints('u2', 3), { defaultModelId: 'openrouter-1' });
    await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/No models available/);
  });
});
