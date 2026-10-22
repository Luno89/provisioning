export const EVAL_COLLECTIONS = ['evalCases', 'evalPrompts', 'evalLevel1Runs', 'evalScenarios', 'evalScenarioRuns', 'evalScenarioProposals', 'evalAgentChanges'] as const;

export type EvalCollection = (typeof EVAL_COLLECTIONS)[number];

export interface EvalRecord {
  id: string;
  ownerId: string;
}

export const evalRecordKey = (ownerId: string, id: string): string => `${ownerId}:${id}`;

export interface EvalRecordStore {
  getEvalRecords<T extends EvalRecord>(collection: EvalCollection, ownerId: string, limit?: number): Promise<T[]>;
  getEvalRecordsInState<T extends EvalRecord>(collection: EvalCollection, state: string): Promise<T[]>;
  getEvalRecord<T extends EvalRecord>(collection: EvalCollection, ownerId: string, id: string): Promise<T | null>;
  saveEvalRecord<T extends EvalRecord>(collection: EvalCollection, record: T): Promise<void>;
  deleteEvalRecord(collection: EvalCollection, ownerId: string, id: string): Promise<void>;
}
