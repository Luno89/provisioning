import { copied } from '../../platform/testing/memory-records.js';
import type { BenchSettings, BenchState } from '../lib/bench.js';
import type { ScriptedRequestRecord } from '../lib/check-script.js';
import { type EvalCollection, type EvalRecord, evalRecordKey } from '../lib/eval-run.js';
import type { ChecksStore } from '../store.js';

const DEFAULT_LIMIT = 200;

const compared = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as string) < (b as string) ? -1 : 1;
};

export class MemoryChecksStore implements ChecksStore {
  private readonly requests: ScriptedRequestRecord[] = [];
  private readonly benchSettings = new Map<string, BenchSettings>();
  private readonly benchStates = new Map<string, BenchState>();
  private readonly evalRecords = new Map<EvalCollection, Map<string, EvalRecord>>();

  async ensureIndexes(): Promise<void> {}

  private records(collection: EvalCollection): Map<string, EvalRecord> {
    let records = this.evalRecords.get(collection);
    if (!records) {
      records = new Map();
      this.evalRecords.set(collection, records);
    }
    return records;
  }

  async saveScriptedRequest(request: ScriptedRequestRecord): Promise<void> {
    this.requests.push(copied(request));
  }

  async getScriptedRequests(ownerId: string): Promise<ScriptedRequestRecord[]> {
    return this.requests
      .filter((request) => request.ownerId === ownerId)
      .sort((a, b) => compared(a.at, b.at))
      .map(copied);
  }

  async getBenchSettings(ownerId: string): Promise<BenchSettings | undefined> {
    const stored = this.benchSettings.get(ownerId);
    return stored ? copied(stored) : undefined;
  }

  async saveBenchSettings(ownerId: string, settings: BenchSettings): Promise<void> {
    this.benchSettings.set(ownerId, copied(settings));
  }

  async getBenchState(ownerId: string): Promise<BenchState | undefined> {
    const stored = this.benchStates.get(ownerId);
    return stored ? copied(stored) : undefined;
  }

  async saveBenchState(state: BenchState): Promise<void> {
    this.benchStates.set(state.ownerId, copied(state));
  }

  async getEvalRecords<T extends EvalRecord>(collection: EvalCollection, ownerId: string, limit = DEFAULT_LIMIT): Promise<T[]> {
    const found = [...this.records(collection).entries()]
      .filter(([, record]) => record.ownerId === ownerId)
      .sort(([keyA, a], [keyB, b]) => compared(
        (b as { startedAt?: unknown }).startedAt,
        (a as { startedAt?: unknown }).startedAt,
      ) || compared(keyA, keyB))
      .map(([, record]) => record);
    return (limit === 0 ? found : found.slice(0, limit)).map((record) => copied(record) as T);
  }

  async getEvalRecordsInState<T extends EvalRecord>(collection: EvalCollection, state: string): Promise<T[]> {
    return [...this.records(collection).values()]
      .filter((record) => (record as { state?: unknown }).state === state)
      .map((record) => copied(record) as T);
  }

  async getEvalRecord<T extends EvalRecord>(collection: EvalCollection, ownerId: string, id: string): Promise<T | null> {
    const stored = this.records(collection).get(evalRecordKey(ownerId, id));
    return stored ? (copied(stored) as T) : null;
  }

  async saveEvalRecord<T extends EvalRecord>(collection: EvalCollection, record: T): Promise<void> {
    this.records(collection).set(evalRecordKey(record.ownerId, record.id), copied(record));
  }

  async deleteEvalRecord(collection: EvalCollection, ownerId: string, id: string): Promise<void> {
    this.records(collection).delete(evalRecordKey(ownerId, id));
  }
}
