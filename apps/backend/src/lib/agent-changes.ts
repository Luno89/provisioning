import type { EvalRecord } from './eval-run.js';

export type AgentChangeStatus = 'proposed' | 'comparing' | 'ready' | 'accepted' | 'handed-over' | 'dismissed';

export interface ScenarioOutcome {
  scenarioId: string;
  before?: boolean | undefined;
  after: boolean;
}

export interface PromptComparison {
  runId?: string | undefined;
  checkedAt: string;
  scenarios: ScenarioOutcome[];
  better: string[];
  worse: string[];
  unchecked?: boolean | undefined;
}

interface ChangeBase extends EvalRecord {
  agent: string;
  why: string;
  status: AgentChangeStatus;
  proposedBy?: string | undefined;
  createdAt: string;
  decidedAt?: string | undefined;
}

export interface PromptChange extends ChangeBase {
  kind: 'prompt';
  prompt: string;
  currentPrompt: string;
  comparison?: PromptComparison | undefined;
}

export interface ProcedureRequest extends ChangeBase {
  kind: 'procedure';
  procedure: string;
  request: string;
  conversationId?: string | undefined;
  runId?: string | undefined;
}

export type AgentChange = PromptChange | ProcedureRequest;

export function compareWithEarlier(
  after: readonly { scenarioId: string; passed: boolean }[],
  earlier: readonly { results: readonly { scenarioId: string; passed: boolean }[] }[],
): Pick<PromptComparison, 'scenarios' | 'better' | 'worse'> {
  const scenarios = after.map((result): ScenarioOutcome => {
    for (const run of earlier) {
      const found = run.results.find((entry) => entry.scenarioId === result.scenarioId);
      if (found) return { scenarioId: result.scenarioId, before: found.passed, after: result.passed };
    }
    return { scenarioId: result.scenarioId, after: result.passed };
  });
  return {
    scenarios,
    better: scenarios.filter((entry) => entry.before === false && entry.after).map((entry) => entry.scenarioId),
    worse: scenarios.filter((entry) => entry.before === true && !entry.after).map((entry) => entry.scenarioId),
  };
}

export function handoffMessage(change: ProcedureRequest): string {
  return [
    `A change to the procedure "${change.procedure}" was requested, for the agent "${change.agent}".`,
    '',
    `What should change: ${change.request}`,
    '',
    `Why: ${change.why}`,
    '',
    'Read the procedure, work out the smallest change that does this, check it, and save it as my own copy.',
  ].join('\n');
}
