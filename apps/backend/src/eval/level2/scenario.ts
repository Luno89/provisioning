import { definitionFor, type Procedure } from '@koala/agent-engine/procedure';
import { scriptProblems, type CheckScript } from '../../lib/check-script.js';
import { stepProcedure, stepProcedureId, type StepUnderTest } from '../../lib/step-check.js';
import { TURN_PROCEDURE_ID, turnChoiceProblems, type TurnChoice } from '../../lib/turn-check.js';
import { platformCatalogue } from '../../extensions/installed.js';
import type { ToolDefinition } from '@koala/agent-engine';
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
  agents?: Record<string, Record<string, unknown>> | undefined;
  project?: { name: string } | undefined;
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

export interface ExpectedHandOff {
  agent: string;
  atLeast?: number | undefined;
  atMost?: number | undefined;
  together?: boolean | undefined;
}

export interface ExpectedFile {
  path: string;
  contains?: string[] | undefined;
}

export interface ScenarioExpectations extends FlowExpectations {
  handOffs?: ExpectedHandOff[] | undefined;
  files?: ExpectedFile[] | undefined;
  outcome?: string | undefined;
  toolsCalled?: string[] | undefined;
  toolsNotCalled?: string[] | undefined;
  toolsSucceeded?: string[] | undefined;
  toolsInOrder?: string[] | undefined;
  tasks?: { id: string; status: TaskStatus }[] | undefined;
  within?: { rounds?: number | undefined; toolCalls?: number | undefined; totalTokens?: number | undefined } | undefined;
  provokes?: ProvokedFailure | undefined;
  saved?: SavedProcedure | undefined;
}

export interface FlowExpectations {
  modelSaw?: { contains?: string[] | undefined; lacks?: string[] | undefined } | undefined;
  compacted?: boolean | undefined;
  summaryKept?: boolean | undefined;
  interrupted?: boolean | undefined;
  turnLog?: { complete: boolean } | undefined;
  leaves?: { verified?: number | undefined; landed?: Record<string, 'merged' | 'nothing'> | undefined; mergeTasks?: number | undefined; findings?: Record<string, string[]> | undefined; artifacts?: Record<string, number> | undefined } | undefined;
  repository?: { of: 'tree' | 'conversation'; files: ExpectedFile[] } | undefined;
  pullRequests?: { merged?: number | undefined; open?: number | undefined; closedUnmerged?: number | undefined } | undefined;
  workspace?: { of: 'tree' | 'conversation'; exists: boolean } | undefined;
  project?: { exists: boolean } | undefined;
  trees?: number | undefined;
  exit?: string | undefined;
  outputs?: Record<string, { equals?: unknown; contains?: string | undefined }> | undefined;
  chooses?: TurnChoice | undefined;
}

export type FlowAction =
  | { chat: { message: string; agent?: string | undefined; inputs?: Record<string, unknown> | undefined; killAfterChars?: number | undefined } }
  | { approvePlan: true }
  | { runTree: true }
  | { waitQuiet: true }
  | { deleteTree: true }
  | { deleteProject: true };

export interface FlowStage {
  name: string;
  do: FlowAction;
  expect?: ScenarioExpectations | undefined;
}

export interface Scenario {
  id: string;
  name: string;
  describe: string;
  agent: string;
  procedure: { id: string };
  input: { message: string; inputs?: Record<string, unknown> | undefined };
  world?: ScenarioWorld | undefined;
  answers?: Record<string, unknown> | undefined;
  approvals?: 'allow' | 'refuse' | undefined;
  script?: CheckScript | undefined;
  step?: StepUnderTest | undefined;
  turn?: boolean | undefined;
  repeats?: number | undefined;
  passAt?: number | undefined;
  expect: ScenarioExpectations;
  then?: FlowStage[] | undefined;
  ownerId?: string | undefined;
  updatedAt?: string | undefined;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_REPEATS = 25;
const TURN_EXPECTATIONS: readonly (keyof ScenarioExpectations)[] = ['chooses', 'modelSaw'];
const ACTIONS = ['chat', 'approvePlan', 'runTree', 'waitQuiet', 'deleteTree', 'deleteProject'];

function expectationProblems(
  expect: ScenarioExpectations,
  known: { agents: ReadonlySet<string>; tools: readonly ToolDefinition[] },
  toolNames: ReadonlySet<string>,
  where: string,
): string[] {
  const problems: string[] = [];
  for (const name of [...(expect.toolsCalled ?? []), ...(expect.toolsNotCalled ?? []), ...(expect.toolsInOrder ?? []), ...(expect.toolsSucceeded ?? [])]) {
    if (!toolNames.has(name)) problems.push(`${where}it expects ${name}, which is not a tool`);
  }
  for (const task of expect.tasks ?? []) {
    if (!STATUSES.includes(task.status)) problems.push(`${where}"${String(task.status)}" is not a task status`);
  }
  for (const handOff of expect.handOffs ?? []) {
    if (typeof handOff?.agent !== 'string' || !known.agents.has(handOff.agent)) problems.push(`${where}it expects hand-offs to "${String(handOff?.agent)}", which is not an agent`);
    for (const bound of [handOff?.atLeast, handOff?.atMost]) {
      if (bound !== undefined && (!Number.isInteger(bound) || bound < 0)) problems.push(`${where}a count of hand-offs to ${handOff.agent} has to be a whole number`);
    }
  }
  for (const file of [...(expect.files ?? []), ...(expect.repository?.files ?? [])]) {
    if (typeof file?.path !== 'string' || !file.path.trim() || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      problems.push(`${where}"${String(file?.path)}" is not a path inside the workspace — give it relative to /work, without ..`);
    }
    if (file?.contains !== undefined && (!Array.isArray(file.contains) || file.contains.some((text) => typeof text !== 'string'))) problems.push(`${where}what ${file.path} should say has to be a list of words`);
  }
  if (expect.repository && !['tree', 'conversation'].includes(expect.repository.of)) problems.push(`${where}a repository is the tree's or the conversation's`);
  if (expect.workspace && !['tree', 'conversation'].includes(expect.workspace.of)) problems.push(`${where}a workspace is the tree's or the conversation's`);
  if (expect.saved && (typeof expect.saved.procedure !== 'string' || !expect.saved.procedure.trim() || typeof expect.saved.stored !== 'boolean')) {
    problems.push(`${where}what it expects to be saved has to name a procedure and say whether it is stored`);
  }
  if (expect.provokes) {
    const tool = known.tools.find((candidate) => candidate.name === expect.provokes!.tool);
    if (!tool) problems.push(`${where}it provokes ${expect.provokes.tool}, which is not a tool`);
    else if (!tool.failures.some((failure) => failure.when === expect.provokes!.when)) {
      problems.push(`${where}${tool.name} does not list "${expect.provokes.when}" as a failure`);
    }
    if (!['retried', 'reported'].includes(expect.provokes.then)) problems.push(`${where}a provoked failure has to expect it was retried or reported`);
  }
  if (expect.chooses !== undefined && where) problems.push(`${where}only a turn check's own expectations can say what the model chooses`);
  else if (expect.chooses !== undefined) problems.push(...turnChoiceProblems(expect.chooses, known.tools));
  if (!where && Object.values(expect).every((entry) => entry === undefined)) problems.push('the scenario has to expect something');
  return problems;
}
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
  if (scenario.step !== undefined) {
    const built = typeof scenario.step?.node === 'string' ? stepProcedure(String(scenario.id), scenario.step, platformCatalogue()) : { problems: ['a step check has to name the node it checks'] };
    if ('problems' in built) problems.push(...built.problems.map((problem) => `its step: ${problem}`));
    else problems.push(...stepExpectationProblems(scenario.step, [scenario.expect]));
    if (scenario.then?.length) problems.push('a step check checks one node, so it has no stages after it');
    if (scenario.step?.from !== undefined && typeof scenario.step.from !== 'string') problems.push('its step: "from" names the procedure the step was taken from');
    if (scenario.procedure?.id !== stepProcedureId(String(scenario.id))) problems.push(`a step check runs the procedure made for it, ${stepProcedureId(String(scenario.id))}`);
  } else if (scenario.turn !== undefined) {
    if (scenario.turn !== true) problems.push('turn is true for a turn check, or left out');
    if (scenario.then?.length) problems.push('a turn check is one model turn, so it has no stages after it');
    if (scenario.procedure?.id !== TURN_PROCEDURE_ID) problems.push(`a turn check runs the procedure made for it, ${TURN_PROCEDURE_ID}`);
    if (scenario.expect && scenario.expect.chooses === undefined) problems.push('a turn check has to expect what the model chooses');
    const others = Object.entries(scenario.expect ?? {}).filter(([key, entry]) => entry !== undefined && !TURN_EXPECTATIONS.includes(key as keyof ScenarioExpectations)).map(([key]) => key);
    if (others.length > 0) problems.push(`nothing runs in a turn check, so it can only expect ${TURN_EXPECTATIONS.join(' and ')}, not ${others.join(', ')}`);
  } else if (!scenario.procedure || typeof scenario.procedure.id !== 'string') problems.push('the scenario has to name the procedure to run');
  else if (!known.procedures.has(scenario.procedure.id) && !(scenario.world?.procedures ?? []).some((procedure) => procedure.id === scenario.procedure!.id)) {
    problems.push(`there is no procedure called "${scenario.procedure.id}"`);
  }
  if (scenario.step !== undefined && scenario.turn !== undefined) problems.push('a check is a step check or a turn check, not both');
  if (scenario.expect?.chooses !== undefined && scenario.turn !== true) problems.push('only a turn check can expect what the model chooses — set turn to true');
  if (scenario.repeats !== undefined && (!Number.isInteger(scenario.repeats) || scenario.repeats < 1 || scenario.repeats > MAX_REPEATS)) problems.push(`repeats has to be a whole number from 1 to ${MAX_REPEATS}`);
  if (scenario.passAt !== undefined && (!Number.isInteger(scenario.passAt) || scenario.passAt < 1 || scenario.passAt > (scenario.repeats ?? 1))) problems.push(`passAt has to be a whole number from 1 to its repeats (${scenario.repeats ?? 1})`);
  if (!scenario.input || typeof scenario.input.message !== 'string' || !scenario.input.message.trim()) problems.push('the scenario has to say what the run is asked to do');

  for (const task of scenario.world?.tasks ?? []) {
    if (!task.id?.trim() || !task.title?.trim() || !task.doneMeans?.trim()) problems.push('every task in the world needs an id, a title and what done means');
    if (task.status !== undefined && !STATUSES.includes(task.status)) problems.push(`"${String(task.status)}" is not a task status`);
  }
  for (const [path, content] of Object.entries(scenario.world?.files ?? {})) {
    if (path.startsWith('/') || path.includes('..')) problems.push(`"${path}" has to be a path inside the workspace`);
    if (typeof content !== 'string') problems.push(`the file "${path}" has to be text`);
  }

  if (!scenario.expect || typeof scenario.expect !== 'object') problems.push('the scenario has to expect something');
  else problems.push(...expectationProblems(scenario.expect, known, toolNames, ''));

  if (scenario.script !== undefined) problems.push(...scriptProblems(scenario.script, new Set([...toolNames, ...known.agents])).map((problem) => `its script: ${problem}`));
  for (const [slug, settings] of Object.entries(scenario.world?.agents ?? {})) {
    if (!known.agents.has(slug)) problems.push(`its world changes "${slug}", which is not an agent`);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) problems.push(`its world's settings for ${slug} have to be an object`);
  }
  if (scenario.world?.project !== undefined && (typeof scenario.world.project.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(scenario.world.project.name))) {
    problems.push('the world\'s project needs a name of lower-case words joined by dashes');
  }
  if ((scenario.then ?? []).some((stage) => stage?.do && 'deleteProject' in stage.do) && !scenario.world?.project) problems.push('a check can only delete the project its world declares');
  if (scenario.then !== undefined && !Array.isArray(scenario.then)) problems.push('what happens next has to be a list of stages');
  for (const [index, stage] of (scenario.then ?? []).entries()) {
    const where = `stage ${index + 2}`;
    if (!stage || typeof stage.name !== 'string' || !stage.name.trim()) problems.push(`${where} needs a name`);
    const action = stage?.do as Record<string, unknown> | undefined;
    const kinds = action ? Object.keys(action) : [];
    if (kinds.length !== 1 || !ACTIONS.includes(kinds[0]!)) problems.push(`${where} has to do one of ${ACTIONS.join(', ')}`);
    const chat = (action?.chat ?? undefined) as { message?: unknown; agent?: unknown } | undefined;
    if (kinds[0] === 'chat' && (typeof chat?.message !== 'string' || !chat.message.trim())) problems.push(`${where} has to say what is asked`);
    if (kinds[0] === 'chat' && chat?.agent !== undefined && (typeof chat.agent !== 'string' || !known.agents.has(chat.agent))) problems.push(`${where} talks to "${String(chat.agent)}", which is not an agent`);
    if (stage?.expect !== undefined) problems.push(...expectationProblems(stage.expect, known, toolNames, `${where}: `));
  }
  if ((scenario.expect?.modelSaw || (scenario.then ?? []).some((stage) => stage.expect?.modelSaw)) && !scenario.script) {
    problems.push('only a scripted check can see what the model was sent — give it a script');
  }

  return problems;
}

export function stepExpectationProblems(step: StepUnderTest, expectations: readonly (ScenarioExpectations | undefined)[]): string[] {
  const definition = definitionFor(platformCatalogue(), { kind: step.node, settings: step.settings ?? {} });
  if (!definition) return [];
  const exits = definition.role === 'step' ? definition.exits.map((exit) => exit.name) : [];
  const outputs = definition.outputs.map((output) => output.name);
  const problems: string[] = [];
  for (const expect of expectations) {
    if (expect?.exit !== undefined) {
      if (exits.length === 0) problems.push(`${step.node} has no exits to leave by — expect one of its outputs instead (${outputs.join(', ')})`);
      else if (!exits.includes(expect.exit)) problems.push(`${step.node} leaves by ${exits.map((exit) => `"${exit}"`).join(' or ')}, never "${expect.exit}"`);
    }
    for (const name of Object.keys(expect?.outputs ?? {})) {
      if (!outputs.includes(name)) problems.push(`${step.node} has no output "${name}" — it has ${outputs.map((output) => `"${output}"`).join(', ') || 'none'}`);
    }
  }
  return problems;
}
