import type { ToolDefinition } from '@koala/agent-engine';
import type { Task } from '../../engine-host/tools/tasks.js';
import { BUILT_IN_GROUPS, builtInCatalogue, formatProcedureProblems, readAndCheckProcedure } from '@koala/agent-engine/procedure';
import type { ProvokedFailure, ScenarioExpectations } from './scenario.js';

export interface ToolCallLog {
  runId: string;
  name: string;
  arguments: string;
  ok: boolean;
  digest: string;
}

export interface StoredProcedure {
  id: string;
  source: string;
}

export interface Observed {
  outcome: string;
  reason?: string | undefined;
  calls: ToolCallLog[];
  tasks: Task[];
  counters: { rounds: number; toolCalls: number; totalTokens: number };
  answer: string;
  saved: StoredProcedure[];
}

export interface Check {
  what: string;
  passed: boolean;
  detail: string;
}

export const failureMatcher = (says: string): RegExp =>
  new RegExp(says.split(/<[^>]+>/).map((part) => part.trim()).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');

export function failedCalls(calls: readonly ToolCallLog[], provoked: ProvokedFailure, tools: readonly ToolDefinition[]): ToolCallLog[] {
  const says = tools.find((tool) => tool.name === provoked.tool)?.failures.find((failure) => failure.when === provoked.when)?.says;
  const matches = says ? failureMatcher(says) : undefined;
  return calls.filter((call) => call.name === provoked.tool && !call.ok && (!matches || matches.test(call.digest)));
}

const list = (names: readonly string[]): string => names.join(', ') || 'nothing';

export interface ScoreOptions {
  tools: readonly ToolDefinition[];
  reported?: ((says: string, answer: string) => Promise<boolean>) | undefined;
}

export async function scoreScenario(expect: ScenarioExpectations, observed: Observed, options: ScoreOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const called = observed.calls.map((call) => call.name);
  const add = (what: string, passed: boolean, detail: string) => checks.push({ what, passed, detail });

  if (expect.outcome !== undefined) {
    add(`finishes ${expect.outcome}`, observed.outcome === expect.outcome,
      observed.outcome === expect.outcome ? `it finished ${observed.outcome}` : `it finished ${observed.outcome}${observed.reason ? `: ${observed.reason}` : ''}`);
  }

  for (const name of expect.toolsCalled ?? []) {
    add(`calls ${name}`, called.includes(name), called.includes(name) ? `it called ${name}` : `it called ${list([...new Set(called)])}`);
  }

  for (const name of expect.toolsNotCalled ?? []) {
    add(`never calls ${name}`, !called.includes(name), called.includes(name) ? `it called ${name}` : `it did not call ${name}`);
  }

  if (expect.toolsInOrder?.length) {
    let at = 0;
    for (const name of called) if (at < expect.toolsInOrder.length && name === expect.toolsInOrder[at]) at += 1;
    add(`calls ${expect.toolsInOrder.join(' then ')}`, at === expect.toolsInOrder.length,
      at === expect.toolsInOrder.length ? 'it called them in that order' : `it got as far as ${at === 0 ? 'none of them' : expect.toolsInOrder.slice(0, at).join(' then ')}, calling ${list(called)}`);
  }

  for (const wanted of expect.tasks ?? []) {
    const task = observed.tasks.find((candidate) => candidate.id === wanted.id);
    add(`leaves ${wanted.id} ${wanted.status}`, task?.status === wanted.status,
      task ? `it is ${task.status}${task.evidence ? `: ${task.evidence.slice(0, 120)}` : ''}` : `there is no task called ${wanted.id}`);
  }

  for (const [measure, ceiling] of Object.entries(expect.within ?? {})) {
    if (ceiling === undefined) continue;
    const spent = observed.counters[measure as keyof Observed['counters']];
    add(`within ${ceiling} ${measure}`, spent <= ceiling, `it used ${spent}`);
  }

  if (expect.saved) {
    const found = observed.saved.find((entry) => entry.id === expect.saved!.procedure);
    if (!expect.saved.stored) {
      add(`saves no procedure called ${expect.saved.procedure}`, !found,
        found ? `it saved ${expect.saved.procedure}` : `nothing called ${expect.saved.procedure} was saved`);
    } else if (!found) {
      add(`saves ${expect.saved.procedure}`, false,
        observed.saved.length > 0 ? `it saved ${list(observed.saved.map((entry) => entry.id))}` : 'it saved nothing');
    } else {
      const checked = readAndCheckProcedure(found.source, { catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS });
      add(`saves ${expect.saved.procedure}, and what is stored checks clean`, checked.ok,
        checked.ok ? `${found.id} is stored and checks clean` : `${found.id} is stored but does not check clean:\n${formatProcedureProblems(checked.problems)}`);
    }
  }

  const provoked = expect.provokes;
  if (provoked) {
    const failures = failedCalls(observed.calls, provoked, options.tools);
    add(`${provoked.tool} fails when ${provoked.when}`, failures.length > 0,
      failures.length > 0 ? `${provoked.tool} failed: ${failures[0]!.digest.slice(0, 120)}` : `${provoked.tool} never failed that way`);

    if (failures.length > 0) {
      const after = observed.calls.slice(observed.calls.indexOf(failures.at(-1)!) + 1);
      if (provoked.then === 'retried') {
        const retried = after.find((call) => call.name === provoked.tool && call.ok);
        add('it tries again with what the failure told it', Boolean(retried), retried ? `it called ${provoked.tool} again and that worked` : `it never called ${provoked.tool} successfully afterwards`);
      } else {
        const says = options.tools.find((tool) => tool.name === provoked.tool)?.failures.find((failure) => failure.when === provoked.when)?.says ?? provoked.when;
        const told = observed.answer.trim() ? await (options.reported?.(says, observed.answer) ?? Promise.resolve(false)) : false;
        add('it tells the person what went wrong', told, told ? 'its answer says what failed' : `its answer does not say what failed: "${observed.answer.slice(0, 120)}"`);
      }
    }
  }

  return checks;
}
