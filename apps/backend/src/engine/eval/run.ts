import { scoreAttempt, type Attempt, type CaseOutcome } from './score.js';
import type { EvalCase } from './cases.js';
import type { ToolDefinition } from '../catalogue.js';
import type { ModelCallArgs, ModelCallOutcome, RunEnvironment, RunTicket } from '../temporal/contracts.js';

export interface Endpoint {
  label: string;
  baseUrl: string;
  model?: string | undefined;
  apiKey?: string | undefined;
}

export interface EvalPorts {
  call(args: ModelCallArgs): Promise<ModelCallOutcome>;
  environment(ticket: RunTicket): Promise<RunEnvironment>;
  catalogue(ownerId: string): Promise<ToolDefinition[]>;
}

export interface EvalOptions {
  ports: EvalPorts;
  ownerId: string;
  repeats?: number | undefined;
  modelId?: string | undefined;
  onAttempt?: ((entry: EvalCase, attempt: number, complaint?: string) => void) | undefined;
}

export const DEFAULT_REPEATS = 5;

const ticketFor = (entry: EvalCase, ownerId: string, attempt: number): RunTicket => ({
  runId: `eval-${entry.name.replace(/[^a-z0-9]+/gi, '-')}-${attempt}`,
  depth: 0,
  ownerId,
  agentSlug: entry.agent,
  trigger: 'user',
});

export async function runCase(entry: EvalCase, options: EvalOptions): Promise<CaseOutcome> {
  const repeats = entry.repeats ?? options.repeats ?? DEFAULT_REPEATS;
  const catalogue = await options.ports.catalogue(options.ownerId);
  const contract = catalogue.find((tool) => tool.name === entry.expect.tool);

  const complaints: string[] = [];
  let passed = 0;

  for (let attempt = 0; attempt < repeats; attempt += 1) {
    const ticket = ticketFor(entry, options.ownerId, attempt);
    const environment = await options.ports.environment(ticket);

    let outcome: ModelCallOutcome;
    try {
      outcome = await options.ports.call({
        ticket,
        nodeId: 'eval',
        environment,
        tools: 'granted',
        ...(options.modelId ? { modelId: options.modelId } : {}),
        messages: [{ role: 'user', content: entry.say }],
      });
    } catch (err) {
      complaints.push(`the call itself failed: ${(err as Error).message}`);
      options.onAttempt?.(entry, attempt, complaints.at(-1));
      continue;
    }

    const made: Attempt = { toolCalls: outcome.toolCalls, content: outcome.content };
    const verdict = scoreAttempt(made, entry.expect, contract);

    if (verdict.passed) passed += 1;
    else if (verdict.complaint) complaints.push(verdict.complaint);

    options.onAttempt?.(entry, attempt, verdict.complaint);
  }

  return { name: entry.name, category: entry.category, attempts: repeats, passed, complaints };
}

export async function runSuite(
  cases: readonly EvalCase[],
  options: EvalOptions,
): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  for (const entry of cases) outcomes.push(await runCase(entry, options));
  return outcomes;
}

export interface Reliability {
  cases: number;
  always: number;
  never: number;
  flaky: number;
}

export function reliability(outcomes: readonly CaseOutcome[]): Reliability {
  return {
    cases: outcomes.length,
    always: outcomes.filter((outcome) => outcome.passed === outcome.attempts).length,
    never: outcomes.filter((outcome) => outcome.passed === 0).length,
    flaky: outcomes.filter((outcome) => outcome.passed > 0 && outcome.passed < outcome.attempts).length,
  };
}
