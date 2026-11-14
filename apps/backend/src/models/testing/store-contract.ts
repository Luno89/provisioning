import { describe, expect, it } from 'vitest';
import type { ModelThinkingProfile } from '../../engine/index.js';
import type { ModelEndpointMetadata } from '../../platform/index.js';
import type { ModelsStore } from '../store.js';
import type { ToolCallParser } from '../lib/tool-call-parsers.js';

const endpoint = (id: string, extra: Partial<ModelEndpointMetadata> = {}): ModelEndpointMetadata => ({
  id,
  ownerId: 'owner-1',
  name: `endpoint ${id}`,
  baseUrl: `http://${id}.example/v1`,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const profile = (modelId: string, extra: Partial<ModelThinkingProfile> = {}): ModelThinkingProfile => ({
  modelId,
  successSamples: 4,
  failureSamples: 2,
  avgSuccessEntropy: 1.5,
  avgFailureEntropy: 2.5,
  avgSuccessRepetition: 0.1,
  avgFailureRepetition: 0.4,
  avgSuccessThoughtLength: 300,
  avgFailureThoughtLength: 900,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const parser = (name: string, extra: Partial<ToolCallParser> = {}): ToolCallParser => ({
  parser: name,
  label: `the ${name} parser`,
  template: [{ contains: '<tool_call>' }, { matches: '\\{"name": <[a-z-]+>' }],
  names: ['(^|/)qwen3-'],
  shipped: true,
  ...extra,
});

export function modelsStoreContract(make: () => Promise<ModelsStore>): void {
  describe('the tool call parsers', () => {
    it('has none before any is saved, keeps each as saved in name order, replaces one saved again and forgets one deleted', async () => {
      const store = await make();
      expect(await store.getToolCallParsers()).toEqual([]);
      await store.saveToolCallParser(parser('qwen3_xml'));
      await store.saveToolCallParser(parser('hermes', { names: [], template: [{ contains: '<tool_call>' }] }));
      await store.saveToolCallParser(parser('mine', { shipped: false, template: [], names: [] }));
      expect(await store.getToolCallParsers()).toEqual([parser('hermes', { names: [], template: [{ contains: '<tool_call>' }] }), parser('mine', { shipped: false, template: [], names: [] }), parser('qwen3_xml')]);
      await store.saveToolCallParser(parser('qwen3_xml', { label: 'Qwen3-Coder' }));
      expect((await store.getToolCallParsers()).find((row) => row.parser === 'qwen3_xml')).toEqual(parser('qwen3_xml', { label: 'Qwen3-Coder' }));
      await store.deleteToolCallParser('hermes');
      await store.deleteToolCallParser('never');
      expect((await store.getToolCallParsers()).map((row) => row.parser)).toEqual(['mine', 'qwen3_xml']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveToolCallParser(parser('hermes'));
      const [read] = await store.getToolCallParsers();
      read!.names.push('changed');
      read!.label = 'changed';
      expect(await store.getToolCallParsers()).toEqual([parser('hermes')]);
    });
  });

  describe('the model endpoints', () => {
    it('keeps an endpoint as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      const full = endpoint('e1', { model: 'qwen', apiKeyEnc: 'sealed', isMesh: true, contextTokens: 32000, pricing: { promptPerMTok: 0.5, completionPerMTok: 1.5 }, intelligence: 42, lastCheckedAt: '2026-10-02T00:00:00.000Z', lastError: 'down' });
      await store.saveModelEndpoint(full);
      await store.saveModelEndpoint(endpoint('e2'));
      expect(await store.getModelEndpoints()).toEqual([full, endpoint('e2')]);
      await store.saveModelEndpoint(endpoint('e1', { name: 'renamed' }));
      const replaced = (await store.getModelEndpoints()).find((stored) => stored.id === 'e1');
      expect(replaced).toEqual(endpoint('e1', { name: 'renamed' }));
      expect(replaced).not.toHaveProperty('apiKeyEnc');
      await store.deleteModelEndpoint('e1');
      expect((await store.getModelEndpoints()).map((stored) => stored.id)).toEqual(['e2']);
    });

    it('has none to list before any is saved, and deleting one it does not have changes nothing', async () => {
      const store = await make();
      expect(await store.getModelEndpoints()).toEqual([]);
      await store.saveModelEndpoint(endpoint('e1'));
      await store.deleteModelEndpoint('never');
      expect((await store.getModelEndpoints()).map((stored) => stored.id)).toEqual(['e1']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveModelEndpoint(endpoint('e1', { pricing: { promptPerMTok: 1, completionPerMTok: 2 } }));
      const [read] = await store.getModelEndpoints();
      read!.name = 'changed';
      read!.pricing!.promptPerMTok = 99;
      const [again] = await store.getModelEndpoints();
      expect(again?.name).toBe('endpoint e1');
      expect(again?.pricing?.promptPerMTok).toBe(1);
    });
  });

  describe('what is known of how a model thinks', () => {
    it('has no profile for a model it never saw', async () => {
      const store = await make();
      expect(await store.getModelThinkingProfile?.('unknown')).toBeNull();
    });

    it('keeps a profile for each model and replaces a model\'s when saved again', async () => {
      const store = await make();
      await store.saveModelThinkingProfile?.(profile('m1'));
      await store.saveModelThinkingProfile?.(profile('m2', { successSamples: 9 }));
      expect(await store.getModelThinkingProfile?.('m1')).toEqual(profile('m1'));
      expect((await store.getModelThinkingProfile?.('m2'))?.successSamples).toBe(9);
      await store.saveModelThinkingProfile?.(profile('m1', { successSamples: 5, updatedAt: '2026-10-09T00:00:00.000Z' }));
      expect(await store.getModelThinkingProfile?.('m1')).toEqual(profile('m1', { successSamples: 5, updatedAt: '2026-10-09T00:00:00.000Z' }));
      expect((await store.getModelThinkingProfile?.('m2'))?.successSamples).toBe(9);
    });

    it('hands back a copy of a profile', async () => {
      const store = await make();
      await store.saveModelThinkingProfile?.(profile('m1'));
      const read = await store.getModelThinkingProfile?.('m1');
      read!.successSamples = 100;
      expect((await store.getModelThinkingProfile?.('m1'))?.successSamples).toBe(4);
    });
  });
}
