import type { AreaStore } from '../platform/index.js';
import type { BenchSettings, BenchState } from './lib/bench.js';
import type { Db } from 'mongodb';
import { type EvalCollection, type EvalRecord, evalRecordKey } from './lib/eval-run.js';
import type { ScriptedRequestRecord } from './lib/check-script.js';

export interface ChecksStore extends AreaStore {
  saveScriptedRequest(request: ScriptedRequestRecord): Promise<void>;
  getScriptedRequests(ownerId: string): Promise<ScriptedRequestRecord[]>;
  getBenchSettings(ownerId: string): Promise<BenchSettings | undefined>;
  saveBenchSettings(ownerId: string, settings: BenchSettings): Promise<void>;
  getBenchState(ownerId: string): Promise<BenchState | undefined>;
  saveBenchState(state: BenchState): Promise<void>;
  getEvalRecords<T extends EvalRecord>(collection: EvalCollection, ownerId: string, limit?: number): Promise<T[]>;
  getEvalRecordsInState<T extends EvalRecord>(collection: EvalCollection, state: string): Promise<T[]>;
  getEvalRecord<T extends EvalRecord>(collection: EvalCollection, ownerId: string, id: string): Promise<T | null>;
  saveEvalRecord<T extends EvalRecord>(collection: EvalCollection, record: T): Promise<void>;
  deleteEvalRecord(collection: EvalCollection, ownerId: string, id: string): Promise<void>;
}

export class MongoChecksStore implements ChecksStore {
  constructor(private readonly db: () => Db) {}

  async ensureIndexes(): Promise<void> {}

  async saveScriptedRequest(request: ScriptedRequestRecord): Promise<void> {
    await this.db().collection('scriptedRequests').insertOne({ ...request });
  }

  async getScriptedRequests(ownerId: string): Promise<ScriptedRequestRecord[]> {
    const docs = await this.db().collection('scriptedRequests').find({ ownerId }).sort({ at: 1, _id: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as ScriptedRequestRecord);
  }

  async getBenchSettings(ownerId: string): Promise<BenchSettings | undefined> {
    const doc = await this.db().collection('benchSettings').findOne({ _id: ownerId as any });
    if (!doc) return undefined;
    const { _id, ...settings } = doc;
    return settings as unknown as BenchSettings;
  }

  async saveBenchSettings(ownerId: string, settings: BenchSettings): Promise<void> {
    await this.db().collection('benchSettings').replaceOne({ _id: ownerId as any }, { ...settings }, { upsert: true });
  }

  async getBenchState(ownerId: string): Promise<BenchState | undefined> {
    const doc = await this.db().collection('benchStates').findOne({ _id: ownerId as any });
    if (!doc) return undefined;
    const { _id, ...state } = doc;
    return state as unknown as BenchState;
  }

  async saveBenchState(state: BenchState): Promise<void> {
    await this.db().collection('benchStates').replaceOne({ _id: state.ownerId as any }, { ...state }, { upsert: true });
  }

  async getEvalRecords<T extends EvalRecord>(collection: EvalCollection, ownerId: string, limit = 200): Promise<T[]> {
    const docs = await this.db().collection(collection).find({ ownerId }).sort({ startedAt: -1, _id: 1 }).limit(limit).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as T);
  }

  async getEvalRecordsInState<T extends EvalRecord>(collection: EvalCollection, state: string): Promise<T[]> {
    const docs = await this.db().collection(collection).find({ state }).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as T);
  }

  async getEvalRecord<T extends EvalRecord>(collection: EvalCollection, ownerId: string, id: string): Promise<T | null> {
    const doc = await this.db().collection(collection).findOne({ _id: evalRecordKey(ownerId, id) as any });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest as unknown as T;
  }

  async saveEvalRecord<T extends EvalRecord>(collection: EvalCollection, record: T): Promise<void> {
    await this.db().collection(collection).replaceOne({ _id: evalRecordKey(record.ownerId, record.id) as any }, { ...record }, { upsert: true });
  }

  async deleteEvalRecord(collection: EvalCollection, ownerId: string, id: string): Promise<void> {
    await this.db().collection(collection).deleteOne({ _id: evalRecordKey(ownerId, id) as any });
  }
}
