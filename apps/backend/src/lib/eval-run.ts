export const EVAL_COLLECTIONS = ['evalCases', 'evalPrompts', 'evalLevel1Runs', 'evalScenarios', 'evalScenarioRuns'] as const;

export type EvalCollection = (typeof EVAL_COLLECTIONS)[number];

export interface EvalRecord {
  id: string;
  ownerId: string;
}

export const evalRecordKey = (ownerId: string, id: string): string => `${ownerId}:${id}`;
