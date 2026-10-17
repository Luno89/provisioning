import { definitionFor, type Procedure } from '@koala/agent-engine/procedure';
import { scriptProblems, type CheckScript } from '../../lib/check-script.js';
import { stepProcedure, stepProcedureId, type StepUnderTest } from '../../lib/step-check.js';
import { TURN_PROCEDURE_ID, turnChoiceProblems, type TurnChoice } from '../../lib/turn-check.js';
import { platformCatalogue } from '../../extensions/installed.js';
import { checkDefinition, type ToolDefinition } from '@koala/agent-engine';
import { SEPARATOR, slugify } from '../../lib/mcp-tools.js';
import { serverProblems, type McpServerRecord } from '../../lib/mcp-servers.js';
import type { TaskStatus } from '../../engine-host/tools/tasks.js';
import type { ReleaseState } from '../../lib/odoo-release.js';

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
  model?: string | undefined;
  tool?: string | undefined;
  server?: string | undefined;
}

export interface ScenarioWorld {
  tasks?: WorldTask[] | undefined;
  procedures?: Procedure[] | undefined;
  memories?: WorldMemory[] | undefined;
  files?: Record<string, string> | undefined;
  acceptProposedWork?: boolean | undefined;
  agents?: Record<string, Record<string, unknown>> | undefined;
  tools?: ToolDefinition[] | undefined;
  mcpServers?: WorldServer[] | undefined;
  project?: { name: string } | undefined;
  apps?: Array<{ name: string; appType: string }> | undefined;
  treeTypes?: Record<string, Record<string, unknown>> | undefined;
}

export type WorldServer = Pick<McpServerRecord, 'name' | 'runs' | 'summary' | 'offer' | 'omit' | 'notes' | 'dependsOn' | 'tools'>;

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
  lacks?: string[] | undefined;
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
  said?: { contains?: string[] | undefined; means?: string[] | undefined } | undefined;
}

export type BrowserTestStatus = 'passed' | 'failed' | 'flaky' | 'skipped';

export interface ExpectedBrowserTests {
  state?: 'passed' | 'failed' | 'unavailable' | undefined;
  tests?: Record<string, BrowserTestStatus> | undefined;
  artifacts?: number | undefined;
}

export interface ExpectedRelease {
  state?: ReleaseState | undefined;
  e2e?: ExpectedBrowserTests | undefined;
  exists?: boolean | undefined;
}

export interface FlowExpectations {
  modelSaw?: { contains?: string[] | undefined; lacks?: string[] | undefined; anyRequest?: boolean | undefined } | undefined;
  compacted?: boolean | undefined;
  summaryKept?: boolean | undefined;
  interrupted?: boolean | undefined;
  turnLog?: { complete: boolean } | undefined;
  leaves?: { verified?: number | undefined; landed?: Record<string, 'merged' | 'nothing'> | undefined; mergeTasks?: number | undefined; findings?: Record<string, string[]> | undefined; artifacts?: Record<string, number> | undefined; retried?: Record<string, number> | undefined } | undefined;
  repository?: { of: 'tree' | 'conversation'; files: ExpectedFile[] } | undefined;
  pullRequests?: { merged?: number | undefined; open?: number | undefined; closedUnmerged?: number | undefined } | undefined;
  workspace?: { of: 'tree' | 'conversation'; exists: boolean } | undefined;
  project?: { exists: boolean } | undefined;
  mcpServer?: { name: string; state?: 'captured' | 'failed' | undefined; heldBy?: string[] | undefined } | undefined;
  releasedBy?: { project?: boolean | undefined; treeType?: string | undefined; agent: string; app?: string | undefined } | undefined;
  treeModels?: { chosen?: string[] | undefined; own?: string[] | undefined } | undefined;
  alertRules?: Array<{ app: string; kind: string }> | undefined;
  trees?: number | undefined;
  exit?: string | undefined;
  outputs?: Record<string, { equals?: unknown; contains?: string | undefined }> | undefined;
  chooses?: TurnChoice | undefined;
  release?: ExpectedRelease | undefined;
  e2e?: ExpectedBrowserTests | undefined;
  plan?: { type?: string | undefined; version?: string | undefined; release?: string | null | undefined; startsFrom?: 'client-database' | null | undefined } | undefined;
  clientImport?: { state: string | null } | undefined;
  build?: { held?: boolean | undefined } | undefined;
  noticed?: string[] | undefined;
}

export type ChatPlace = 'channel' | { story: string } | { feature: string };

export type FlowAction =
  | { chat: { message: string; agent?: string | undefined; inputs?: Record<string, unknown> | undefined; killAfterChars?: number | undefined; in?: ChatPlace | undefined } }
  | { post: { message: string; in: 'channel' } }
  | { approvePlan: true | { in: Exclude<ChatPlace, 'channel'> } }
  | { applyAction: true }
  | { runTree: true }
  | { waitQuiet: true }
  | { settleTree: true }
  | { editWorkspace: Record<string, unknown> }
  | { waitWorkspace: true }
  | { deleteTree: true }
  | { deleteProject: true }
  | { waitRelease: { state: 'preview' | 'live' } }
  | { waitBuild: true }
  | { cutOver: true }
  | { browse: { release: 'preview' | 'live'; specs?: Record<string, string> | undefined } }
  | { removeRelease: true };

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
  onBench?: boolean | undefined;
  expect: ScenarioExpectations;
  then?: FlowStage[] | undefined;
  ownerId?: string | undefined;
  updatedAt?: string | undefined;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_REPEATS = 25;
const TURN_EXPECTATIONS: readonly (keyof ScenarioExpectations)[] = ['chooses', 'modelSaw'];
const ACTIONS = ['chat', 'post', 'approvePlan', 'applyAction', 'runTree', 'waitQuiet', 'settleTree', 'editWorkspace', 'waitWorkspace', 'deleteTree', 'deleteProject', 'waitRelease', 'waitBuild', 'cutOver', 'browse', 'removeRelease'];
const RELEASE_ACTIONS = ['waitRelease', 'waitBuild', 'cutOver', 'browse', 'removeRelease'];
const RELEASE_STATES: ReleaseState[] = ['preparing', 'preview', 'cutting-over', 'live', 'discarded', 'failed', 'superseded'];
const TEST_STATUSES: BrowserTestStatus[] = ['passed', 'failed', 'flaky', 'skipped'];
const SPEC_PATH = /^e2e\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.spec\.ts$/;

function browserTestProblems(expect: ExpectedBrowserTests, where: string): string[] {
  const problems: string[] = [];
  if (expect.state !== undefined && !['passed', 'failed', 'unavailable'].includes(expect.state)) problems.push(`${where}browser tests end passed, failed or unavailable, never "${String(expect.state)}"`);
  for (const [title, status] of Object.entries(expect.tests ?? {})) {
    if (!TEST_STATUSES.includes(status)) problems.push(`${where}the browser test "${title}" can be ${TEST_STATUSES.join(', ')}, not "${String(status)}"`);
  }
  if (expect.artifacts !== undefined && (!Number.isInteger(expect.artifacts) || expect.artifacts < 0)) problems.push(`${where}how many browser files are kept has to be a whole number`);
  return problems;
}

function expectationProblems(
  expect: ScenarioExpectations,
  known: { agents: ReadonlySet<string>; tools: readonly ToolDefinition[]; apps?: ReadonlySet<string> | undefined },
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
  if (expect.mcpServer !== undefined) {
    const server = expect.mcpServer as { name?: unknown; state?: unknown; heldBy?: unknown };
    if (typeof server.name !== 'string' || !server.name.trim()) problems.push(`${where}it expects an MCP server, but names none`);
    if (server.state !== undefined && server.state !== 'captured' && server.state !== 'failed') problems.push(`${where}an MCP server is expected captured or failed`);
    if (server.heldBy !== undefined && (!Array.isArray(server.heldBy) || server.heldBy.some((slug) => typeof slug !== 'string' || !known.agents.has(slug)))) problems.push(`${where}the MCP server is expected held by agents there are`);
  }
  if (expect.releasedBy !== undefined) {
    const released = expect.releasedBy as { project?: unknown; treeType?: unknown; agent?: unknown; app?: unknown };
    if ((released.project === true) === (typeof released.treeType === 'string')) problems.push(`${where}how builds are released is expected of either the world's project or a tree type`);
    if (typeof released.agent !== 'string' || !released.agent.trim()) problems.push(`${where}it expects builds released by an agent, but names none`);
    if (released.app !== undefined && typeof released.app !== 'string') problems.push(`${where}the release's app adapter is a name`);
  }
  if (expect.alertRules !== undefined) {
    const rules = expect.alertRules as unknown;
    const apps = known.apps ?? new Set<string>();
    if (!Array.isArray(rules) || rules.some((rule) => !apps.has((rule as { app?: string }).app ?? '') || typeof (rule as { kind?: unknown }).kind !== 'string')) problems.push(`${where}the alerts it expects name the world's apps and a kind`);
  }
  if (expect.treeModels !== undefined) {
    const models = expect.treeModels as { chosen?: unknown; own?: unknown };
    for (const [which, list] of [['chosen', models.chosen], ['own', models.own]] as const) {
      if (list !== undefined && (!Array.isArray(list) || list.some((slug) => typeof slug !== 'string' || !known.agents.has(slug)))) problems.push(`${where}the tree's models name agents there are, as ${which}`);
    }
    if (models.chosen === undefined && models.own === undefined) problems.push(`${where}it expects the tree's models, but names no agent`);
  }
  const said = expect.said as { contains?: unknown; means?: unknown } | undefined;
  if (said !== undefined) {
    for (const [which, list] of [['contains', said.contains], ['means', said.means]] as const) {
      if (list !== undefined && (!Array.isArray(list) || list.some((text) => typeof text !== 'string' || !text.trim()))) problems.push(`${where}what it should have said (${which}) has to be a list of sentences`);
    }
    if (said.contains === undefined && said.means === undefined) problems.push(`${where}it expects something said, but names nothing`);
  }
  if (expect.plan !== undefined) {
    const plan = expect.plan as Record<string, unknown>;
    for (const key of ['type', 'version'] as const) if (plan[key] !== undefined && typeof plan[key] !== 'string') problems.push(`${where}the plan's ${key} is a name`);
    if (plan.release !== undefined && plan.release !== null && typeof plan.release !== 'string') problems.push(`${where}the plan's release is the agent that releases it, or null for its type's own way`);
    if (plan.startsFrom !== undefined && plan.startsFrom !== null && plan.startsFrom !== 'client-database') problems.push(`${where}the plan starts from client-database, or null for the starter`);
  }
  if (expect.clientImport !== undefined && expect.clientImport.state !== null && !['awaited', 'uploading', 'uploaded', 'refused', 'importing', 'imported', 'failed'].includes(String(expect.clientImport.state))) problems.push(`${where}"${String(expect.clientImport.state)}" is not a state of a client's database`);
  if (expect.noticed !== undefined && (!Array.isArray(expect.noticed) || expect.noticed.some((text) => typeof text !== 'string' || !text.trim()))) problems.push(`${where}what the channel should have been told has to be a list of words`);
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
    if (file?.lacks !== undefined && (!Array.isArray(file.lacks) || file.lacks.some((text) => typeof text !== 'string'))) problems.push(`${where}what ${file.path} must not say has to be a list of words`);
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
  if (expect.release?.state !== undefined && !RELEASE_STATES.includes(expect.release.state)) problems.push(`${where}"${String(expect.release.state)}" is not a release state`);
  if (expect.release?.e2e) problems.push(...browserTestProblems(expect.release.e2e, `${where}the release's `));
  if (expect.e2e) problems.push(...browserTestProblems(expect.e2e, where));
  if (expect.chooses !== undefined && where) problems.push(`${where}only a turn check's own expectations can say what the model chooses`);
  else if (expect.chooses !== undefined) problems.push(...turnChoiceProblems(expect.chooses, known.tools));
  if (!where && Object.values(expect).every((entry) => entry === undefined)) problems.push('the scenario has to expect something');
  return problems;
}
const STATUSES: TaskStatus[] = ['proposed', 'accepted', 'running', 'waiting', 'done', 'failed', 'dropped'];

class ToolNames extends Set<string> {
  constructor(names: readonly string[], readonly served: readonly string[]) {
    super(names);
  }

  override has(name: string): boolean {
    return super.has(name) || this.served.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
  }
}

export function scenarioProblems(
  value: unknown,
  known: { agents: ReadonlySet<string>; procedures: ReadonlySet<string>; tools: readonly ToolDefinition[] },
): string[] {
  if (typeof value !== 'object' || value === null) return ['a scenario has to be an object'];
  const scenario = value as Partial<Scenario>;
  const problems: string[] = [];
  const worldTools = Array.isArray(scenario.world?.tools) ? scenario.world.tools : [];
  const worldServers = Array.isArray(scenario.world?.mcpServers) ? scenario.world.mcpServers : [];
  const worldAppNames = new Set(Array.isArray(scenario.world?.apps) ? scenario.world.apps.map((app) => app?.name) : []);
  const toolNames = new ToolNames(
    [...known.tools, ...worldTools].map((tool) => tool.name),
    worldServers.map((server) => `${slugify(server.name)}${SEPARATOR}`),
  );
  if (scenario.world?.mcpServers !== undefined && !Array.isArray(scenario.world.mcpServers)) problems.push('its world\'s MCP servers have to be a list');
  worldServers.forEach((server, at) => {
    for (const problem of serverProblems(server, worldServers.slice(0, at).map((other, index) => ({ id: String(index), name: other.name })))) problems.push(`its world's MCP server ${String(server.name)}: ${problem}`);
  });
  if (scenario.world?.tools !== undefined && !Array.isArray(scenario.world.tools)) problems.push('its world\'s tools have to be a list');
  for (const tool of worldTools) {
    if (known.tools.some((existing) => existing.name === tool.name)) problems.push(`its world defines "${tool.name}", which is already a tool`);
    for (const problem of checkDefinition(tool)) problems.push(`its world's tool ${problem.tool} ${problem.message}`);
  }

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
  if (scenario.onBench !== undefined && typeof scenario.onBench !== 'boolean') problems.push('onBench has to be true or false');
  if (scenario.passAt !== undefined && (!Number.isInteger(scenario.passAt) || scenario.passAt < 1 || scenario.passAt > (scenario.repeats ?? 1))) problems.push(`passAt has to be a whole number from 1 to its repeats (${scenario.repeats ?? 1})`);
  if (!scenario.input || typeof scenario.input.message !== 'string' || !scenario.input.message.trim()) problems.push('the scenario has to say what the run is asked to do');

  for (const task of scenario.world?.tasks ?? []) {
    if (!task.id?.trim() || !task.title?.trim() || !task.doneMeans?.trim()) problems.push('every task in the world needs an id, a title and what done means');
    if (task.status !== undefined && !STATUSES.includes(task.status)) problems.push(`"${String(task.status)}" is not a task status`);
  }
  for (const memory of scenario.world?.memories ?? []) {
    if (typeof memory.title !== 'string' || !memory.title.trim() || typeof memory.text !== 'string' || !memory.text.trim()) problems.push('every memory in the world needs a title and a text');
    if (memory.model !== undefined && (typeof memory.model !== 'string' || !memory.model.trim())) problems.push(`the memory "${String(memory.title)}" names a model that is not a name`);
    if (memory.category === 'tool_note' && !(typeof memory.tool === 'string' && memory.tool.trim()) && !(typeof memory.server === 'string' && memory.server.trim())) problems.push(`the tool note "${String(memory.title)}" names no tool or server`);
  }
  for (const [path, content] of Object.entries(scenario.world?.files ?? {})) {
    if (path.startsWith('/') || path.includes('..')) problems.push(`"${path}" has to be a path inside the workspace`);
    if (typeof content !== 'string') problems.push(`the file "${path}" has to be text`);
  }

  if (!scenario.expect || typeof scenario.expect !== 'object') problems.push('the scenario has to expect something');
  else problems.push(...expectationProblems(scenario.expect, { ...known, apps: worldAppNames }, toolNames, ''));

  if (scenario.script !== undefined) problems.push(...scriptProblems(scenario.script, new ToolNames([...toolNames, ...known.agents], toolNames.served)).map((problem) => `its script: ${problem}`));
  for (const [slug, settings] of Object.entries(scenario.world?.agents ?? {})) {
    if (!known.agents.has(slug)) problems.push(`its world changes "${slug}", which is not an agent`);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) problems.push(`its world's settings for ${slug} have to be an object`);
    else if ('slug' in settings || 'ownerId' in settings) problems.push(`its world's settings for ${slug} cannot change its slug or owner`);
    else if ('tools' in settings) {
      const tools = (settings as { tools?: unknown }).tools;
      if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) problems.push(`its world's tools for ${slug} have to be a list of tool names`);
      else for (const tool of tools) if (!toolNames.has(tool)) problems.push(`its world grants ${slug} "${tool}", which is not a tool`);
    }
    if (settings && typeof settings === 'object' && 'servers' in settings) {
      const servers = (settings as { servers?: unknown }).servers;
      if (!Array.isArray(servers) || servers.some((server) => typeof server !== 'string')) problems.push(`its world's servers for ${slug} have to be a list of server names`);
      else for (const server of servers) if (!worldServers.some((own) => own.name === server)) problems.push(`its world gives ${slug} the MCP server "${server}", which its world does not have`);
    }
  }
  for (const [id, settings] of Object.entries(scenario.world?.treeTypes ?? {})) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) problems.push(`its world's settings for the tree type ${id} have to be an object`);
    else if ('id' in settings || 'ownerId' in settings) problems.push(`its world's settings for the tree type ${id} cannot change its id or owner`);
  }
  if (scenario.world?.project !== undefined && (typeof scenario.world.project.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(scenario.world.project.name))) {
    problems.push('the world\'s project needs a name of lower-case words joined by dashes');
  }
  if (scenario.world?.apps !== undefined) {
    const apps = scenario.world.apps as unknown;
    if (!Array.isArray(apps)) problems.push('the world\'s apps have to be a list');
    else {
      const names = apps.map((app) => (app as { name?: unknown }).name);
      if (apps.some((app) => typeof (app as { name?: unknown }).name !== 'string' || !/^[a-z][a-z0-9-]{0,20}$/.test((app as { name: string }).name) || typeof (app as { appType?: unknown }).appType !== 'string')) problems.push('each of the world\'s apps needs a short lower-case name and an appType');
      if (new Set(names).size !== names.length) problems.push('the world\'s apps need different names');
    }
  }
  const stages = Array.isArray(scenario.then) ? scenario.then : [];
  const approvedAt = stages.findIndex((stage) => stage?.do && typeof stage.do === 'object' && 'approvePlan' in stage.do);
  const hasProject = (index: number) => scenario.world?.project !== undefined || (approvedAt >= 0 && index >= approvedAt);
  if (stages.some((stage, index) => stage?.do && typeof stage.do === 'object' && 'deleteProject' in stage.do && !hasProject(index))) problems.push('a check can only delete a project its world declares or an approved plan made');
  const releasingAt = (stage: FlowStage | undefined) => Boolean(stage?.do && typeof stage.do === 'object' && RELEASE_ACTIONS.some((kind) => kind in stage.do)) || stage?.expect?.release !== undefined || stage?.expect?.clientImport !== undefined || stage?.expect?.build !== undefined || stage?.expect?.noticed !== undefined;
  if (scenario.expect?.release !== undefined && !scenario.world?.project) problems.push('a check can only release a project its world declares or an approved plan made');
  else if (stages.some((stage, index) => releasingAt(stage) && !hasProject(index))) problems.push('a check can only release a project its world declares or an approved plan made');
  if (scenario.expect?.e2e !== undefined) problems.push('the first run does not browse, so it has no browser tests of its own — browse in a later stage');
  if (scenario.then !== undefined && !Array.isArray(scenario.then)) problems.push('what happens next has to be a list of stages');
  for (const [index, stage] of (scenario.then ?? []).entries()) {
    const where = `stage ${index + 2}`;
    if (!stage || typeof stage.name !== 'string' || !stage.name.trim()) problems.push(`${where} needs a name`);
    const action = stage?.do as Record<string, unknown> | undefined;
    const kinds = action ? Object.keys(action) : [];
    if (kinds.length !== 1 || !ACTIONS.includes(kinds[0]!)) problems.push(`${where} has to do one of ${ACTIONS.join(', ')}`);
    const chat = (action?.chat ?? undefined) as { message?: unknown; agent?: unknown; in?: unknown } | undefined;
    const item = chat?.in && typeof chat.in === 'object' ? chat.in as Record<string, unknown> : undefined;
    const namesItem = item !== undefined && Object.keys(item).length === 1 && ((typeof item.story === 'string' && item.story.trim() !== '') || (typeof item.feature === 'string' && item.feature.trim() !== ''));
    if (kinds[0] === 'chat' && chat?.in !== undefined && chat.in !== 'channel' && !namesItem) problems.push(`${where} talks in the channel, in a story's or a feature's chat named by its title, or in the check's own conversation`);
    const approving = action?.approvePlan;
    const approvingIn = approving && typeof approving === 'object' ? (approving as { in?: unknown }).in : undefined;
    const approvesItem = approvingIn && typeof approvingIn === 'object' && Object.keys(approvingIn).length === 1
      && ((typeof (approvingIn as Record<string, unknown>).story === 'string') || (typeof (approvingIn as Record<string, unknown>).feature === 'string'));
    if (kinds[0] === 'applyAction' && action?.applyAction !== true) problems.push(`${where} applies the card waiting in the check's own conversation (applyAction: true)`);
    if (kinds[0] === 'approvePlan' && approving !== true && !approvesItem) problems.push(`${where} approves what waits in the check's own conversation (approvePlan: true), or in a story's or a feature's chat named by its title`);
    const post = (action?.post ?? undefined) as { message?: unknown; in?: unknown } | undefined;
    if (kinds[0] === 'post' && (typeof post?.message !== 'string' || !post.message.trim() || post.in !== 'channel')) problems.push(`${where} posts a message in the channel`);
    if (kinds[0] === 'chat' && (typeof chat?.message !== 'string' || !chat.message.trim())) problems.push(`${where} has to say what is asked`);
    if (kinds[0] === 'chat' && chat?.agent !== undefined && (typeof chat.agent !== 'string' || !known.agents.has(chat.agent))) problems.push(`${where} talks to "${String(chat.agent)}", which is not an agent`);
    const waiting = action?.waitRelease as { state?: unknown } | undefined;
    if (kinds[0] === 'waitRelease' && !['preview', 'live'].includes(String(waiting?.state))) problems.push(`${where} waits for a release in preview or live`);
    const browsing = action?.browse as { release?: unknown; specs?: unknown } | undefined;
    if (kinds[0] === 'browse') {
      if (!['preview', 'live'].includes(String(browsing?.release))) problems.push(`${where} browses the release in preview or the live one`);
      if (browsing?.specs !== undefined) {
        const specs = browsing.specs;
        if (!specs || typeof specs !== 'object' || Array.isArray(specs) || Object.keys(specs).length === 0) problems.push(`${where}'s specs are files by path`);
        else for (const [path, content] of Object.entries(specs)) {
          if (!SPEC_PATH.test(path) || path.split('/').includes('..')) problems.push(`${where}: "${path}" has to be a spec under e2e/ ending .spec.ts`);
          if (typeof content !== 'string' || !content.trim()) problems.push(`${where}: the spec ${path} has to be text`);
        }
      }
    }
    if (stage?.expect?.e2e !== undefined && kinds[0] !== 'browse') problems.push(`${where} does not browse, so it has no browser tests of its own — expect the release's instead`);
    if (stage?.expect !== undefined) problems.push(...expectationProblems(stage.expect, { ...known, apps: worldAppNames }, toolNames, `${where}: `));
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
