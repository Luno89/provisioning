import type { ModelThinkingProfile } from '../../engine/index.js';
import type { ModelEndpointMetadata } from '../../platform/index.js';
import { asStored } from '../../platform/testing/as-stored.js';
import { copied, MemoryRecords } from '../../platform/testing/memory-records.js';
import type { ModelsStore } from '../store.js';

export class MemoryModelsStore implements ModelsStore {
  private readonly endpoints = new MemoryRecords<ModelEndpointMetadata>();
  private readonly thinkingProfiles = new Map<string, ModelThinkingProfile>();

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
}
