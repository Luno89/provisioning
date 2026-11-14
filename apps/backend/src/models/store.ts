import { type AreaStore, fromDoc } from '../platform/lib/collection.js';
import type { Collection, Db } from 'mongodb';
import type { ModelEndpointMetadata } from '../platform/index.js';
import type { ModelThinkingProfile } from '../engine/index.js';
import type { ToolCallParser } from './lib/tool-call-parsers.js';

export interface ModelsStore extends AreaStore {
  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
  deleteModelEndpoint(id: string): Promise<void>;
  getModelThinkingProfile?(modelId: string): Promise<ModelThinkingProfile | null>;
  saveModelThinkingProfile?(profile: ModelThinkingProfile): Promise<void>;
  getToolCallParsers(): Promise<ToolCallParser[]>;
  saveToolCallParser(parser: ToolCallParser): Promise<void>;
  deleteToolCallParser(parser: string): Promise<void>;
}

type StoredParser = Omit<ToolCallParser, 'parser'> & { _id: string };

export class MongoModelsStore implements ModelsStore {
  constructor(private readonly db: () => Db) {}

  private get modelEndpoints(): Collection<{ _id: string }> {
    return this.db().collection<{ _id: string }>('modelEndpoints');
  }

  private get thinkingProfiles(): Collection {
    return this.db().collection('model_thinking_profiles');
  }

  private get toolCallParsers(): Collection<StoredParser> {
    return this.db().collection<StoredParser>('toolCallParsers');
  }

  async ensureIndexes(): Promise<void> {}

  async getModelEndpoints(): Promise<ModelEndpointMetadata[]> {
    return (await this.modelEndpoints.find({}).toArray()).map(doc => fromDoc<ModelEndpointMetadata>(doc));
  }

  async saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void> {
    const { id, ...rest } = endpoint;
    await this.modelEndpoints.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async deleteModelEndpoint(id: string): Promise<void> {
    await this.modelEndpoints.deleteOne({ _id: id });
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

  async getToolCallParsers(): Promise<ToolCallParser[]> {
    const docs = await this.toolCallParsers.find({}).sort({ _id: 1 }).toArray();
    return docs.map(({ _id, label, template, names, shipped }) => ({ parser: _id, label, template, names, shipped }));
  }

  async saveToolCallParser(parser: ToolCallParser): Promise<void> {
    const { parser: id, label, template, names, shipped } = parser;
    await this.toolCallParsers.replaceOne({ _id: id }, { label, template, names, shipped }, { upsert: true });
  }

  async deleteToolCallParser(parser: string): Promise<void> {
    await this.toolCallParsers.deleteOne({ _id: parser });
  }
}
