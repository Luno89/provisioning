import type { Procedure } from '@koala/agent-engine/procedure';
import type { RunBudget, ToolDefinition } from '@koala/agent-engine';
import type { TaskStatus } from '../../engine-host/tools/tasks.js';

export interface WorldTask {
  id: string;
  title: string;
  doneMeans: string;
  status?: TaskStatus | undefined;
  agent?: string | undefined;
  dependsOn?: string[] | undefined;
  checks?: { command?: string | undefined; expects?: string[] | undefined } | undefined;
}

export interface WorldMemory {
  title: string;
  text: string;
  category?: string | undefined;
}

export interface ScenarioWorld {
  tasks?: WorldTask[] | undefined;
  procedures?: Procedure[] | undefined;
  memories?: WorldMemory[] | undefined;
  files?: Record<string, string> | undefined;
  acceptProposedWork?: boolean | undefined;
}

export interface ProvokedFailure {
  tool: string;
  when: string;
  then: 'retried' | 'reported';
}

export interface SavedProcedure {
  procedure: string;
  stored: boolean;
}

export interface ScenarioExpectations {
  outcome?: string | undefined;
  toolsCalled?: string[] | undefined;
  toolsNotCalled?: string[] | undefined;
  toolsInOrder?: string[] | undefined;
  tasks?: { id: string; status: TaskStatus }[] | undefined;
  within?: { rounds?: number | undefined; toolCalls?: number | undefined; totalTokens?: number | undefined } | undefined;
  provokes?: ProvokedFailure | undefined;
  saved?: SavedProcedure | undefined;
}

export interface Scenario {
  id: string;
  name: string;
  describe: string;
  agent: string;
  procedure: { id: string; version?: string | undefined };
  input: { message: string; inputs?: Record<string, unknown> | undefined };
  world?: ScenarioWorld | undefined;
  answers?: Record<string, unknown> | undefined;
  approvals?: 'allow' | 'refuse' | undefined;
  budget?: RunBudget | undefined;
  expect: ScenarioExpectations;
  ownerId?: string | undefined;
  updatedAt?: string | undefined;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const STATUSES: TaskStatus[] = ['proposed', 'accepted', 'running', 'done', 'failed', 'dropped'];

export function scenarioProblems(
  value: unknown,
  known: { agents: ReadonlySet<string>; procedures: ReadonlySet<string>; tools: readonly ToolDefinition[] },
): string[] {
  if (typeof value !== 'object' || value === null) return ['a scenario has to be an object'];
  const scenario = value as Partial<Scenario>;
  const problems: string[] = [];
  const toolNames = new Set(known.tools.map((tool) => tool.name));

  if (typeof scenario.id !== 'string' || !ID.test(scenario.id)) problems.push('the id has to be lower-case words joined by dashes');
  if (typeof scenario.name !== 'string' || !scenario.name.trim()) problems.push('the scenario needs a name');
  if (typeof scenario.describe !== 'string' || !scenario.describe.trim()) problems.push('the scenario has to say what it checks');
  if (typeof scenario.agent !== 'string' || !known.agents.has(scenario.agent)) problems.push(`there is no agent called "${String(scenario.agent)}"`);
  if (!scenario.procedure || typeof scenario.procedure.id !== 'string') problems.push('the scenario has to name the procedure to run');
  else if (!known.procedures.has(scenario.procedure.id) && !(scenario.world?.procedures ?? []).some((procedure) => procedure.id === scenario.procedure!.id)) {
    problems.push(`there is no procedure called "${scenario.procedure.id}"`);
  }
  if (!scenario.input || typeof scenario.input.message !== 'string' || !scenario.input.message.trim()) problems.push('the scenario has to say what the run is asked to do');

  for (const task of scenario.world?.tasks ?? []) {
    if (!task.id?.trim() || !task.title?.trim() || !task.doneMeans?.trim()) problems.push('every task in the world needs an id, a title and what done means');
    if (task.status !== undefined && !STATUSES.includes(task.status)) problems.push(`"${String(task.status)}" is not a task status`);
  }
  for (const [path, content] of Object.entries(scenario.world?.files ?? {})) {
    if (path.startsWith('/') || path.includes('..')) problems.push(`"${path}" has to be a path inside the workspace`);
    if (typeof content !== 'string') problems.push(`the file "${path}" has to be text`);
  }

  const expect = scenario.expect;
  if (!expect || typeof expect !== 'object') {
    problems.push('the scenario has to expect something');
  } else {
    for (const name of [...(expect.toolsCalled ?? []), ...(expect.toolsNotCalled ?? []), ...(expect.toolsInOrder ?? [])]) {
      if (!toolNames.has(name)) problems.push(`it expects ${name}, which is not a tool`);
    }
    for (const task of expect.tasks ?? []) {
      if (!STATUSES.includes(task.status)) problems.push(`"${String(task.status)}" is not a task status`);
    }
    if (expect.saved && (typeof expect.saved.procedure !== 'string' || !expect.saved.procedure.trim() || typeof expect.saved.stored !== 'boolean')) {
      problems.push('what it expects to be saved has to name a procedure and say whether it is stored');
    }
    if (expect.provokes) {
      const tool = known.tools.find((candidate) => candidate.name === expect.provokes!.tool);
      if (!tool) problems.push(`it provokes ${expect.provokes.tool}, which is not a tool`);
      else if (!tool.failures.some((failure) => failure.when === expect.provokes!.when)) {
        problems.push(`${tool.name} does not list "${expect.provokes.when}" as a failure`);
      }
      if (!['retried', 'reported'].includes(expect.provokes.then)) problems.push('a provoked failure has to expect it was retried or reported');
    }
    if (Object.values(expect).every((entry) => entry === undefined)) problems.push('the scenario has to expect something');
  }

  return problems;
}
