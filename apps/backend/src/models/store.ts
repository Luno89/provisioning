import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db } from 'mongodb';
import type { ModelEndpointMetadata } from '../platform/index.js';
import type { ModelThinkingProfile } from '../engine/lib/thinking-classifier.js';

export interface ModelsStore extends AreaStore {
  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
  deleteModelEndpoint(id: string): Promise<void>;
  getModelThinkingProfile?(modelId: string): Promise<ModelThinkingProfile | null>;
  saveModelThinkingProfile?(profile: ModelThinkingProfile): Promise<void>;
}

export class MongoModelsStore implements ModelsStore {
  constructor(private readonly db: () => Db) {}

  private get modelEndpoints(): Collection {
    return this.db().collection('modelEndpoints');
  }

  private get thinkingProfiles(): Collection {
    return this.db().collection('model_thinking_profiles');
  }

  async ensureIndexes(): Promise<void> {}

  async getModelEndpoints(): Promise<ModelEndpointMetadata[]> {
    return (await this.modelEndpoints.find({}).toArray()).map(doc => fromDoc<ModelEndpointMetadata>(doc));
  }

  async saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void> {
    const doc = toDoc(endpoint);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.modelEndpoints.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteModelEndpoint(id: string): Promise<void> {
    await this.modelEndpoints.deleteOne({ _id: id as any });
  }

  async getModelThinkingProfile(modelId: string): Promise<ModelThinkingProfile | null> {
    const doc = await this.thinkingProfiles.findOne({ modelId });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest as unknown as ModelThinkingProfile;
  }

  async saveModelThinkingProfile(profile: ModelThinkingProfile): Promise<void> {
    const { _id: _ignored, ...doc } = profile as ModelThinkingProfile & { _id?: unknown };
    await this.thinkingProfiles.replaceOne({ modelId: profile.modelId }, doc, { upsert: true });
  }
}
