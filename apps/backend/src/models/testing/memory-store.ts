import type { ModelThinkingProfile } from '../../engine/index.js';
import type { ModelEndpointMetadata } from '../../platform/index.js';
import { asStored } from '../../platform/testing/as-stored.js';
import { collectionIn, copied, MemoryRecords, type Collections } from '../../platform/testing/memory-records.js';
import type { ModelsStore } from '../store.js';
import type { ToolCallParser } from '../lib/tool-call-parsers.js';

export class MemoryModelsStore implements ModelsStore {
  private readonly endpoints: MemoryRecords<ModelEndpointMetadata>;
  private readonly thinkingProfiles = new Map<string, ModelThinkingProfile>();
  private readonly parsers: Map<string, ToolCallParser>;

  constructor(collections: Collections = new Map()) {
    this.endpoints = new MemoryRecords(collectionIn<ModelEndpointMetadata>(collections, 'modelEndpoints'));
    this.parsers = collectionIn<ToolCallParser>(collections, 'toolCallParsers');
  }

  async ensureIndexes(): Promise<void> {}

  async getModelEndpoints(): Promise<ModelEndpointMetadata[]> {
    return this.endpoints.all();
  }

  async saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void> {
    this.endpoints.put(asStored(endpoint));
  }

  async deleteModelEndpoint(id: string): Promise<void> {
    this.endpoints.delete(id);
  }

  async getModelThinkingProfile(modelId: string): Promise<ModelThinkingProfile | null> {
    const profile = this.thinkingProfiles.get(modelId);
    return profile ? copied(profile) : null;
  }

  async saveModelThinkingProfile(profile: ModelThinkingProfile): Promise<void> {
    this.thinkingProfiles.set(profile.modelId, asStored(profile));
  }

  async getToolCallParsers(): Promise<ToolCallParser[]> {
    return [...this.parsers.values()].sort((a, b) => (a.parser < b.parser ? -1 : a.parser > b.parser ? 1 : 0)).map(copied);
  }

  async saveToolCallParser(parser: ToolCallParser): Promise<void> {
    this.parsers.set(parser.parser, asStored(parser));
  }

  async deleteToolCallParser(parser: string): Promise<void> {
    this.parsers.delete(parser);
  }
}
