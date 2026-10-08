import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { Scenario } from '../../eval/level2/scenario.js';
import type { ScenarioResult } from '../../eval/level2/results.js';
import { levelOf, scenarioSubjects, within, type Scope } from '../../lib/check-subjects.js';
import { definitionFor } from '@koala/agent-engine/procedure';
import { platformCatalogue } from '../../extensions/installed.js';

export interface CheckRunView {
  id: string;
  state: string;
  scenarios: string[];
  startedAt: string;
  results: ScenarioResult[];
  error?: string | undefined;
}

export const READ_RESULT_WAIT_MS = 60_000;
const POLL_MS = 3_000;

export interface CheckAccess {
  scenarios(ownerId: string): Promise<(Scenario & { mine: boolean })[]>;
  runs(ownerId: string): Promise<CheckRunView[]>;
  run(ownerId: string, runId: string): Promise<CheckRunView | undefined>;
  save(ownerId: string, scenario: unknown): Promise<{ saved: string } | { problems: string[] }>;
  remove(ownerId: string, id: string): Promise<boolean>;
  start(ownerId: string, input: { only: string[]; modelId?: string | undefined }): Promise<{ runId: string } | { problem: string }>;
}

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const done = (said: string): ToolOutcome => ({ ok: true, digest: said.split('\n')[0]!.slice(0, 200), content: said });

const text = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const lastResult = (runs: readonly CheckRunView[], id: string): { result: ScenarioResult; run: CheckRunView } | undefined => {
  const run = [...runs]
    .filter((one) => one.results.some((result) => result.scenarioId === id))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const result = run?.results.find((one) => one.scenarioId === id);
  return run && result ? { run, result } : undefined;
};

const describeResult = (result: ScenarioResult): string => [
  `${result.passed ? 'passed' : 'failed'}${result.attempts ? ` ${result.passedAttempts ?? 0} of ${result.attempts.length} times (needs ${result.passAt ?? result.attempts.length})` : ''} — run ${result.runId}${result.error ? ` — ${result.error}` : ''}`,
  ...(result.attempts && result.attempts.length > 1 ? [`  attempts: ${result.attempts.map((attempt, index) => `#${index + 1} ${attempt.passed ? '✓' : '✕'} ${attempt.runId}`).join(', ')}`] : []),
  ...result.checks.map((check) => `  ${check.passed ? '✓' : '✕'} ${check.what} — ${check.detail}`),
  ...(result.calls.length > 0 ? [`  tools called: ${result.calls.map((call) => `${call.name}${call.ok ? '' : ' (failed)'}`).join(', ')}`] : []),
].join('\n');

const pace = (scenario: Scenario): string => {
  const times = (scenario.repeats ?? 1) > 1 ? `, ${scenario.repeats} times` : '';
  if (scenario.script) return `on its script${times} — it takes seconds`;
  if (scenario.turn) return `on the person's model${times} — one turn, about a minute${times ? ' each' : ''}`;
  if (scenario.step) {
    const definition = definitionFor(platformCatalogue(), { kind: scenario.step.node, settings: scenario.step.settings ?? {} });
    if (!definition?.inputs.some((input) => input.type === 'modelBinding')) return `with no model${times} — it takes seconds`;
  }
  return `on the person's model${times} — it can take minutes`;
};

export function createCheckTools(access: CheckAccess, options: { waitMs?: number | undefined; pollMs?: number | undefined } = {}): Record<string, ToolHandler> {
  const waitMs = options.waitMs ?? READ_RESULT_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const save = async (parsed: Record<string, unknown>, ownerId: string | undefined, how: 'new' | 'replace'): Promise<ToolOutcome> => {
    if (!ownerId) return refuse('this run has no owner to save a check for');
    const check = parsed.check;
    if (!check || typeof check !== 'object' || Array.isArray(check)) return refuse('send the whole check as an object under "check"');
    const id = typeof (check as { id?: unknown }).id === 'string' ? (check as { id: string }).id : '';
    const existing = id ? (await access.scenarios(ownerId)).find((one) => one.id === id) : undefined;
    if (how === 'new' && existing) return refuse(`there is already a ${existing.mine ? 'check of the person\'s' : 'built-in check'} called "${id}" — change the person's own with update_check, or give yours its own id`);
    if (how === 'replace' && !existing?.mine) return refuse(`the person has no check of their own called "${id}"${existing ? ' — it is built in, so save your version under its own id with write_check' : ''}`);
    const outcome = await access.save(ownerId, check);
    if ('problems' in outcome) return refuse(`nothing was saved — fix these and send the whole check again:\n${outcome.problems.map((problem) => `- ${problem}`).join('\n')}`);
    return done(`${how === 'new' ? 'saved' : 'replaced'} ${outcome.saved}; run it with run_check to see it pass or fail`);
  };

  return {
    async list_checks({ parsed, caller }) {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner whose checks to list');
      const given = (['agent', 'tool', 'procedure'] as const).filter((key) => text(parsed, key));
      if (given.length > 1) return refuse('narrow it by one of agent, tool or procedure, not several');
      const scope = given[0] ? ({ [given[0]]: text(parsed, given[0]) } as Scope) : undefined;
      const [scenarios, runs] = await Promise.all([access.scenarios(ownerId), access.runs(ownerId)]);
      const shown = scenarios.filter((scenario) => !scope || within(scenarioSubjects(scenario), scope));
      if (shown.length === 0) return done(scope ? `no check covers that ${given[0]} yet` : 'there are no checks yet');
      return done(shown.map((scenario) => {
        const last = lastResult(runs, scenario.id);
        return [
          scenario.id,
          levelOf(scenario),
          scenario.script ? 'script' : 'their model',
          scenario.agent,
          scenario.mine ? 'theirs' : 'built-in',
          last ? (last.result.passed ? 'last passed' : 'last failed') : 'never run',
          scenario.name,
        ].join(' · ');
      }).join('\n'));
    },

    async read_check({ parsed, caller }) {
      const ownerId = caller.ownerId;
      const id = text(parsed, 'id');
      if (!ownerId || !id) return refuse('give the id of the check to read');
      const [scenarios, runs] = await Promise.all([access.scenarios(ownerId), access.runs(ownerId)]);
      const scenario = scenarios.find((one) => one.id === id);
      if (!scenario) return refuse(`there is no check called "${id}"`);
      const { mine, ownerId: _owner, updatedAt: _updated, ...check } = scenario;
      const last = lastResult(runs, id);
      return done([
        `${mine ? 'The person\'s own check' : 'A built-in check'} ${id}:`,
        JSON.stringify(check, null, 2),
        last ? `Last run, ${last.run.startedAt}: ${describeResult(last.result)}` : 'It has never run.',
      ].join('\n'));
    },

    async write_check({ parsed, caller }) {
      return save(parsed, caller.ownerId, 'new');
    },

    async update_check({ parsed, caller }) {
      return save(parsed, caller.ownerId, 'replace');
    },

    async run_check({ parsed, caller }) {
      const ownerId = caller.ownerId;
      const id = text(parsed, 'id');
      if (!ownerId || !id) return refuse('give the id of the check to run');
      const scenario = (await access.scenarios(ownerId)).find((one) => one.id === id);
      if (!scenario) return refuse(`there is no check called "${id}"`);
      const modelId = text(parsed, 'modelId');
      const started = await access.start(ownerId, { only: [id], ...(modelId ? { modelId } : {}) });
      if ('problem' in started) return refuse(`it did not start: ${started.problem}`);
      return done(`started run ${started.runId} of ${id} ${pace(scenario)}; read it with read_check_result, which waits for it`);
    },

    async read_check_result({ parsed, caller }) {
      const ownerId = caller.ownerId;
      const runId = text(parsed, 'runId');
      if (!ownerId || !runId) return refuse('give the run id run_check returned');
      let run = await access.run(ownerId, runId);
      if (!run) return refuse(`there is no check run called "${runId}"`);
      for (let waited = 0; run.state === 'running' && waited < waitMs; waited += pollMs) {
        await new Promise((settle) => setTimeout(settle, pollMs));
        run = (await access.run(ownerId, runId)) ?? run;
      }
      if (run.state === 'running') return done(`still running after ${Math.round(waitMs / 1000)}s (${run.results.length} of ${run.scenarios.length} finished) — read it again to keep waiting`);
      if (run.results.length === 0) return done(`it ended ${run.state} without a result${run.error ? `: ${run.error}` : ''}`);
      return done(run.results.map((result) => `${result.scenarioId}: ${describeResult(result)}`).join('\n'));
    },

    async delete_check({ parsed, caller }) {
      const ownerId = caller.ownerId;
      const id = text(parsed, 'id');
      if (!ownerId || !id) return refuse('give the id of the check to delete');
      if (!(await access.remove(ownerId, id))) return refuse(`the person has no check of their own called "${id}"`);
      return done(`deleted ${id}`);
    },
  };
}
