import { CancellationScope, defineSignal, executeChild, isCancellation, proxyActivities, setHandler, uuid4, workflowInfo } from '@temporalio/workflow';
import { DESTROY_RETRY } from '../lib/activity-retry.js';
import { removeAccountWorkflowId } from '../lib/account-removal.js';
import type { CheckProgressArgs, CheckRunActivities, CheckScenarioArgs } from '../activities/CheckRunActivities.js';
import type { Scenario } from '../eval/level2/scenario.js';
import type { ScenarioResult } from '../eval/level2/results.js';
import type { Check } from '../eval/level2/score.js';
import type { PromptChange } from '../lib/check-space.js';
import type { ToolDefinition } from '@koala/agent-engine';
import { RemoveAccountWorkflow } from './RemoveAccountWorkflow.js';
import { combineAttempts } from '../lib/check-attempts.js';
import { ownerIn, startedFor } from '../lib/workflow-owner.js';

const space = proxyActivities<Pick<CheckRunActivities, 'CheckCreateSpaceActivity' | 'CheckSpaceGoneActivity'>>({
  retry: DESTROY_RETRY,
  startToCloseTimeout: '5 minutes',
});

const runs = proxyActivities<Pick<CheckRunActivities, 'CheckRunScenarioActivity'>>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '30 days',
  heartbeatTimeout: '2 minutes',
});

const progress = proxyActivities<{ CheckProgressActivity(args: CheckProgressArgs): Promise<void> }>({
  retry: DESTROY_RETRY,
  startToCloseTimeout: '1 minute',
});

export const cancelCheckSignal = defineSignal<[]>('cancelCheck');

export interface CheckRunInput {
  checkRunId: string;
  person: string;
  scenarios: Scenario[];
  tools: ToolDefinition[];
  modelId?: string | undefined;
  temperature?: number | undefined;
  trialPractice?: string | undefined;
  promptOverride?: PromptChange | undefined;
}

export interface CheckRunOutcome {
  cancelled: boolean;
  results: ScenarioResult[];
}

const unfinished = (scenario: Scenario, error: string): ScenarioResult => ({
  scenarioId: scenario.id,
  name: scenario.name,
  runId: '',
  procedure: { id: scenario.procedure.id, version: '' },
  passed: false,
  outcome: 'failed',
  reason: error,
  answer: '',
  checks: [],
  calls: [],
  counters: { rounds: 0, toolCalls: 0, totalTokens: 0 },
  tasks: [],
  durationMs: 0,
  error,
});

const innermost = (err: unknown): string => {
  let reason = 'the check failed';
  for (let at = err as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (typeof at.message === 'string' && at.message) reason = at.message;
  }
  return reason;
};

export async function CheckRunWorkflow(input: CheckRunInput): Promise<CheckRunOutcome> {
  let cancelled = false;
  let current: CancellationScope | undefined;
  setHandler(cancelCheckSignal, () => {
    cancelled = true;
    current?.cancel();
  });

  const attempt = async (scenario: Scenario, spaceId: string, fresh: boolean): Promise<ScenarioResult> => {
    const base = { spaceId, checkRunId: input.checkRunId, person: input.person, scenario, trialPractice: input.trialPractice, promptOverride: input.promptOverride };
    try {
      if (fresh) await space.CheckCreateSpaceActivity(base);
      const args: CheckScenarioArgs = { ...base, tools: input.tools, modelId: input.modelId, temperature: input.temperature };
      current = new CancellationScope();
      const outcome = await current.run(() => runs.CheckRunScenarioActivity(args));
      return outcome.result;
    } catch (err) {
      return unfinished(scenario, isCancellation(err) ? 'the check was cancelled' : innermost(err));
    } finally {
      current = undefined;
    }
  };

  const gone = async (spaceId: string): Promise<Check> => {
    const left = await CancellationScope.nonCancellable(async () => {
      await executeChild(RemoveAccountWorkflow, { workflowId: removeAccountWorkflowId(spaceId), args: [{ ownerId: spaceId, keepRunsFor: input.person }], ...startedFor(ownerIn(workflowInfo().typedSearchAttributes) ?? input.person) });
      return space.CheckSpaceGoneActivity({ spaceId });
    });
    return { what: 'its space leaves nothing behind', passed: left.length === 0, detail: left.length === 0 ? 'no records, workspaces or Gitea user are left' : `left behind: ${left.join(', ')}` };
  };

  const results: ScenarioResult[] = [];
  for (const scenario of input.scenarios) {
    if (cancelled) break;
    await progress.CheckProgressActivity({ ownerId: input.person, checkRunId: input.checkRunId, running: scenario.id });
    const repeats = scenario.repeats ?? 1;
    const shared = scenario.turn === true;
    const attempts: ScenarioResult[] = [];
    const spaces: Check[] = [];
    let sharedSpace: string | undefined;
    for (let index = 0; index < repeats && !cancelled; index += 1) {
      const spaceId = sharedSpace ?? `space-${uuid4()}`;
      let result: ScenarioResult = unfinished(scenario, 'the check did not run');
      try {
        result = await attempt(scenario, spaceId, spaceId !== sharedSpace);
      } finally {
        if (shared) sharedSpace = spaceId;
        else spaces.push(await gone(spaceId));
      }
      if (cancelled && result.error === 'the check was cancelled') break;
      attempts.push(result);
    }
    if (sharedSpace) spaces.push(await gone(sharedSpace));
    if (attempts.length === 0) break;
    const combined = repeats === 1 ? attempts[0]! : combineAttempts(attempts, scenario.passAt ?? repeats);
    const leaks = spaces.filter((check) => !check.passed);
    const left: Check = spaces.length === 1 ? spaces[0]! : {
      what: 'its spaces leave nothing behind',
      passed: leaks.length === 0,
      detail: leaks.length === 0 ? `none of its ${spaces.length} spaces left anything` : leaks.map((check) => check.detail).join('; '),
    };
    const result = { ...combined, checks: [...combined.checks, left], passed: combined.passed && left.passed };
    results.push(result);
    await progress.CheckProgressActivity({ ownerId: input.person, checkRunId: input.checkRunId, result });
  }
  return { cancelled, results };
}
