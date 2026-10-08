import { Context } from '@temporalio/activity';
import type { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { ToolDefinition } from '@koala/agent-engine';
import type { RunEffort } from '@koala/agent-engine/procedure';
import type { Scenario } from '../eval/level2/scenario.js';
import { scoreScenario, type Check, type Observed, type ObservedFlow, type ObservedHandOff, type StoredProcedure, type ToolCallLog } from '../eval/level2/score.js';
import type { FlowAction, ScenarioExpectations } from '../eval/level2/scenario.js';
import type { ScenarioResult } from '../eval/level2/results.js';
import { newTask, type Task } from '../engine-host/tools/tasks.js';
import type { MemoryItem } from '../lib/memory-store.js';
import type { ProcedureSource } from '../lib/procedure-source.js';
import type { UserMetadata } from '../lib/types.js';
import type { BenchSettings } from '../lib/bench.js';
import type { ExtensionSettings } from '../lib/extension-settings.js';
import type { AuthoredExtension } from '../lib/authored-extensions.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import { reowned, scriptedEndpointId, spacePersonas, spacePractices, spaceUser, type PromptChange } from '../lib/check-space.js';
import { conversationRepoName, conversationWorkspaceRunId, treeWorkspaceRunId } from '../engine-host/sandboxes/workspace-repos.js';
import { CONFLICT_TASK_TITLE } from '../lib/landing.js';
import { encryptValue, type SecretKey } from '../lib/crypto.js';
import type { ModelEndpointMetadata } from '../lib/types.js';
import { randomBytes } from 'node:crypto';
import { seededPersonas } from '../extensions/seeds.js';
import { STEP_NODE, stepProcedure, stepProcedureId } from '../lib/step-check.js';
import { platformCatalogue, platformGroups } from '../extensions/installed.js';
import { TURN_CALL_KIND, TURN_PROCEDURE_ID, turnProcedure, type TurnReply } from '../lib/turn-check.js';

export interface CheckSpaceArgs {
  spaceId: string;
  checkRunId: string;
  person: string;
  scenario: Scenario;
  trialPractice?: string | undefined;
  promptOverride?: PromptChange | undefined;
}

export interface CheckScenarioArgs extends CheckSpaceArgs {
  modelId?: string | undefined;
  temperature?: number | undefined;
  tools: ToolDefinition[];
}

export interface CheckScenarioOutcome {
  result: ScenarioResult;
  runIds: string[];
}

interface Persona { slug: string; ownerId?: string | undefined; prompt?: string | undefined }
interface ToolRecord { ownerId?: string | undefined }

export interface CheckRunStore {
  getUserById(id: string): Promise<UserMetadata | undefined>;
  saveUser(user: UserMetadata): Promise<void>;
  saveBenchSettings(ownerId: string, settings: BenchSettings): Promise<void>;
  getEnginePersonas(ownerId?: string): Promise<Persona[]>;
  saveEnginePersona(persona: never): Promise<void>;
  getProcedures(ownerId?: string): Promise<ProcedureSource[]>;
  saveProcedure(source: ProcedureSource): Promise<void>;
  getEngineTools(ownerId?: string): Promise<ToolRecord[]>;
  saveEngineTool(tool: never): Promise<void>;
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
  getExtensionSettings(ownerId: string): Promise<ExtensionSettings | undefined>;
  saveExtensionSettings(settings: ExtensionSettings): Promise<void>;
  getAuthoredExtensions(ownerId: string): Promise<AuthoredExtension[]>;
  saveAuthoredExtension(extension: AuthoredExtension): Promise<void>;
  getMemories(ownerId?: string): Promise<MemoryItem[]>;
  saveMemory(memory: MemoryItem): Promise<void>;
  saveTask(task: Task): Promise<void>;
  findRunEffort(runId: string): Promise<RunEffort | undefined>;
  reownRuns(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
}

export interface CheckRunDeps {
  store: CheckRunStore;
  api: (space: { id: string; email: string }) => AxiosInstance;
  seedFiles: (ownerId: string, repo: string, files: Record<string, string>) => Promise<void>;
  reported: (args: { spaceId: string; runId: string; agent: string; modelId?: string | undefined }, says: string, answer: string) => Promise<boolean>;
  scripted: { base: string; dataKey: SecretKey };
  terminate: (runId: string, reason: string) => Promise<void>;
  leftovers: { records(ownerId: string): Promise<Record<string, number>>; workspaces(ownerId: string): Promise<string[]>; giteaUser(ownerId: string): Promise<boolean> };
  pollMs?: number;
}

export interface CheckRunActivities {
  CheckCreateSpaceActivity(args: CheckSpaceArgs): Promise<string>;
  CheckRunScenarioActivity(args: CheckScenarioArgs): Promise<CheckScenarioOutcome>;
  CheckSpaceGoneActivity(args: { spaceId: string }): Promise<string[]>;
}

interface LoggedEvent {
  type: string;
  runId: string;
  at?: string;
  nodeId?: string;
  callId?: string;
  name?: string;
  args?: string;
  ok?: boolean;
  digest?: string;
  agentId?: string;
  parentRunId?: string;
  outcome?: string;
  reason?: string;
  message?: string;
  level?: string;
  delta?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const activityContext = (): Context | undefined => {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
};

const now = () => new Date().toISOString();

export function failedResult(scenario: Scenario, runId: string, error: string, startedAt: number): ScenarioResult {
  return {
    scenarioId: scenario.id,
    name: scenario.name,
    runId,
    procedure: { id: scenario.procedure.id, version: '' },
    passed: false,
    outcome: 'failed',
    reason: error,
    answer: '',
    checks: [],
    calls: [],
    counters: { rounds: 0, toolCalls: 0, totalTokens: 0 },
    tasks: [],
    durationMs: Date.now() - startedAt,
    error,
  };
}

export function observedCalls(events: readonly LoggedEvent[]): ToolCallLog[] {
  const results = new Map(events.filter((event) => event.type === 'tool.result' && event.callId).map((event) => [`${event.runId}:${event.callId}`, event]));
  return events
    .filter((event) => event.type === 'tool.called' && event.callId && event.name)
    .map((event) => {
      const result = results.get(`${event.runId}:${event.callId}`);
      return { runId: event.runId, name: event.name!, arguments: event.args ?? '', ok: result?.ok !== false, digest: result?.digest ?? '' };
    });
}

export function observedHandOffs(events: readonly LoggedEvent[], root: string): ObservedHandOff[] {
  const finished = new Map(events.filter((event) => event.type === 'run.finished').map((event) => [event.runId, event]));
  return events
    .filter((event) => event.type === 'run.started' && event.runId !== root && event.parentRunId && event.agentId)
    .map((event) => {
      const end = finished.get(event.runId);
      return {
        agent: event.agentId!,
        startedAt: Date.parse(event.at ?? '') || 0,
        finishedAt: Date.parse(end?.at ?? '') || Number.MAX_SAFE_INTEGER,
        outcome: end?.outcome ?? 'unfinished',
      };
    });
}

export function pendingCalls(events: readonly LoggedEvent[], runId: string): string[] {
  const resulted = new Set(events.filter((event) => event.type === 'tool.result' && event.runId === runId).map((event) => event.callId));
  return events.filter((event) => event.type === 'tool.called' && event.runId === runId && event.callId && !resulted.has(event.callId)).map((event) => event.callId!);
}

const WANTS_TO_RUN = / wants to run /;

export function createCheckRunActivities(deps: CheckRunDeps): CheckRunActivities {
  const { store } = deps;
  const pollMs = deps.pollMs ?? 1_500;

  return {
    async CheckCreateSpaceActivity({ spaceId, checkRunId, person, scenario, trialPractice, promptOverride }) {
      if (await store.getUserById(spaceId)) return spaceId;
      const stamp = now();
      await store.saveUser(spaceUser(spaceId, { person, checkRunId, scenarioId: scenario.id, ...(scenario.script ? { script: scenario.script } : {}) }, stamp));
      await store.saveBenchSettings(spaceId, { enabled: false, idleMinutes: 15, fullEveryHours: 24 });
      if (scenario.script) {
        await store.saveModelEndpoint({
          id: scriptedEndpointId(spaceId),
          ownerId: spaceId,
          name: 'Scripted model',
          baseUrl: `${deps.scripted.base}/${spaceId}/v1`,
          model: 'scripted',
          apiKeyEnc: encryptValue(randomBytes(24).toString('base64url'), deps.scripted.dataKey),
          ...(scenario.script.contextTokens ? { contextTokens: scenario.script.contextTokens } : {}),
          createdAt: stamp,
        } as ModelEndpointMetadata);
      }

      const personas = spacePersonas(await store.getEnginePersonas(person), person, spaceId, promptOverride);
      const builtIn = [...(await store.getEnginePersonas()).filter((persona) => persona.ownerId === undefined), ...seededPersonas()];
      for (const [slug, settings] of Object.entries(scenario.world?.agents ?? {})) {
        const base = personas.find((persona) => persona.slug === slug) ?? builtIn.find((persona) => persona.slug === slug);
        if (!base) throw new Error(`the check's world changes the agent "${slug}", and there is no such agent`);
        const changed = { ...base, ...settings, slug, ownerId: spaceId };
        const at = personas.findIndex((persona) => persona.slug === slug);
        if (at >= 0) personas[at] = changed; else personas.push(changed);
      }
      for (const persona of personas) await store.saveEnginePersona(persona as never);
      for (const procedure of reowned(await store.getProcedures(person), person, spaceId)) await store.saveProcedure(procedure);
      for (const tool of reowned(await store.getEngineTools(person), person, spaceId)) await store.saveEngineTool(tool as never);
      for (const treeType of reowned(await store.getTreeTypes(person), person, spaceId)) await store.saveTreeType(treeType);
      const settings = await store.getExtensionSettings(person);
      if (settings) await store.saveExtensionSettings({ ...settings, ownerId: spaceId });
      for (const extension of reowned(await store.getAuthoredExtensions(person), person, spaceId)) await store.saveAuthoredExtension(extension);
      for (const practice of spacePractices(await store.getMemories(person), person, spaceId, trialPractice)) await store.saveMemory(practice);

      for (const memory of scenario.world?.memories ?? []) {
        await store.saveMemory({ id: `${spaceId}-${uuidv4()}`, ownerId: spaceId, title: memory.title, text: memory.text, category: (memory.category ?? 'lessons_learned') as MemoryItem['category'], createdAt: stamp, updatedAt: stamp });
      }
      if (scenario.step) {
        const built = stepProcedure(scenario.id, scenario.step, platformCatalogue());
        if ('problems' in built) throw new Error(`the step cannot be checked: ${built.problems.join('; ')}`);
        await store.saveProcedure({ id: built.procedure.id, ownerId: spaceId, version: built.procedure.version, source: JSON.stringify(built.procedure), updatedAt: stamp });
      }
      if (scenario.turn) {
        const procedure = turnProcedure(platformCatalogue(), platformGroups());
        await store.saveProcedure({ id: procedure.id, ownerId: spaceId, version: procedure.version, source: JSON.stringify(procedure), updatedAt: stamp });
      }
      for (const procedure of scenario.world?.procedures ?? []) {
        const declared = procedure as { id: string; version: string };
        await store.saveProcedure({ id: declared.id, ownerId: spaceId, version: declared.version, source: JSON.stringify(procedure), updatedAt: stamp });
      }
      for (const seed of scenario.world?.tasks ?? []) {
        const task = newTask({
          id: seed.id, ownerId: spaceId, title: seed.title, doneMeans: seed.doneMeans, dependsOn: seed.dependsOn ?? [],
          ...(seed.agent ? { agent: seed.agent } : {}),
          ...(seed.checks ? { checks: seed.checks } : {}),
        }, stamp);
        await store.saveTask({ ...task, status: seed.status ?? 'accepted' });
      }
      return spaceId;
    },

    async CheckRunScenarioActivity(args) {
      const { scenario, spaceId } = args;
      const startedAt = Date.now();
      const space = await store.getUserById(spaceId);
      if (!space) return { result: failedResult(scenario, '', 'the check\'s space is gone', startedAt), runIds: [] };
      const http = deps.api({ id: space.id, email: space.email });
      const context = activityContext();
      const stopIfCancelled = async (runId?: string) => {
        if (!context?.cancellationSignal.aborted) return;
        if (runId) await http.post(`/engine/runs/${runId}/cancel`, {}).catch(() => undefined);
        throw context.cancellationSignal.reason ?? new Error('the check was cancelled');
      };
      const wait = async () => {
        context?.heartbeat();
        await sleep(pollMs);
      };

      const files = scenario.world?.files ?? {};

      const world: Record<string, unknown> = {};
      if (scenario.world?.project) {
        const made = await http.post('/projects', { name: `${scenario.world.project.name}-${spaceId.slice(-8)}`, giteaRepo: `${scenario.world.project.name}-${spaceId.slice(-8)}`, createRepo: true }, { validateStatus: () => true });
        if (made.status >= 300) return { result: failedResult(scenario, '', `the check's project could not be made: ${(made.data as { error?: string }).error ?? made.status}`, startedAt), runIds: [] };
        const project = made.data as { id: string; name: string; giteaOwner: string; giteaRepo: string };
        Object.assign(world, { projectId: project.id, projectName: project.name, projectRepo: `${project.giteaOwner}/${project.giteaRepo}` });
      }
      const conversationId = ((await http.post('/conversations', typeof world.projectId === 'string' ? { projectId: world.projectId } : {})).data as { id: string }).id;
      world.conversationId = conversationId;
      if (Object.keys(files).length > 0) await deps.seedFiles(spaceId, conversationRepoName(conversationId), files);
      const before = new Map((await store.getProcedures(spaceId)).filter((source) => source.ownerId === spaceId).map((source) => [source.id, source.updatedAt]));
      const fill = <T>(value: T): T => {
        if (typeof value === 'string') return value.replace(/\{\{\s*world\.([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, path: string) => {
          const found = path.split('.').reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), world);
          return found === undefined ? whole : typeof found === 'string' ? found : JSON.stringify(found);
        }) as T;
        if (Array.isArray(value)) return value.map(fill) as T;
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)])) as T;
        return value;
      };
      const remember = async (values: Record<string, unknown>) => {
        Object.assign(world, values);
        const current = await store.getUserById(spaceId);
        if (current?.space) await store.saveUser({ ...current, space: { ...current.space, world: { ...world } } });
      };
      await remember({});

      const runIds = new Set<string>();
      const accept = async () => {
        const proposed = (await http.get('/engine/tasks', { params: { status: 'proposed' } })).data as { id: string }[];
        for (const task of proposed) await http.post(`/engine/tasks/${encodeURIComponent(task.id)}/accept`, {});
      };

      const chat = async (action: { message: string; agent?: string | undefined; inputs?: Record<string, unknown> | undefined; killAfterChars?: number | undefined }, first: boolean) => {
        const agent = action.agent ?? scenario.agent;
        const started = await http.post('/engine/runs', {
          agent,
          message: fill(action.message),
          inputs: { ...fill(action.inputs ?? {}), conversationId },
          conversationId,
          ...(first ? { procedure: scenario.step ? stepProcedureId(scenario.id) : scenario.turn ? TURN_PROCEDURE_ID : scenario.procedure.id } : {}),
          ...(args.modelId ? { modelId: args.modelId } : {}),
          ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
        }, { validateStatus: () => true });
        if (started.status >= 300) throw new Error(`the run would not start: ${(started.data as { error?: string } | undefined)?.error ?? `HTTP ${started.status}`}`);
        const runId = (started.data as { runId: string }).runId;
        runIds.add(runId);

        const events: LoggedEvent[] = [];
        const seqs: number[] = [];
        const answered = new Set<string>();
        const decided = new Set<string>();
        let after = 0;
        for (;;) {
          await stopIfCancelled(runId);
          const entries = ((await http.get(`/turns/${runId}`, { params: { after } })).data as { entries: { seq: number; events: LoggedEvent[] }[] }).entries;
          for (const entry of entries) {
            after = Math.max(after, entry.seq);
            seqs.push(entry.seq);
            for (const event of entry.events) {
              events.push(event);
              runIds.add(event.runId);
              if (event.type === 'node.entered' && event.nodeId && scenario.answers && event.nodeId in scenario.answers && !answered.has(event.nodeId)) {
                answered.add(event.nodeId);
                if (scenario.world?.acceptProposedWork) await accept();
                await http.post(`/engine/runs/${event.runId}/answer`, { nodeId: event.nodeId, value: scenario.answers[event.nodeId] });
              }
              if (event.type === 'notice' && event.level === 'warn' && WANTS_TO_RUN.test(event.message ?? '')) {
                for (const callId of pendingCalls(events, event.runId)) {
                  if (decided.has(callId)) continue;
                  decided.add(callId);
                  await http.post(`/engine/runs/${event.runId}/approve`, { callId, allowed: scenario.approvals !== 'refuse' });
                }
              }
            }
          }
          if (events.some((event) => event.type === 'run.finished' && event.runId === runId)) break;
          const said = events.filter((event) => event.type === 'content' && event.runId === runId).reduce((total, event) => total + (event.delta ?? '').length, 0);
          if (action.killAfterChars !== undefined && said > action.killAfterChars) {
            await deps.terminate(runId, 'the check killed this run mid-turn, as a dying worker would');
            await sleep(2_000);
            break;
          }
          await wait();
        }
        const root = events.find((event) => event.type === 'run.finished' && event.runId === runId) ?? { type: 'run.finished', runId, outcome: 'killed', reason: 'the check killed it mid-turn' };
        let saved: string | undefined;
        let interrupted = false;
        for (let tries = 0; tries < 20 && saved === undefined; tries += 1) {
          const found = (await http.get(`/conversations/${conversationId}`)).data as { messages: { role: string; content: string; runId?: string; interruptedReason?: string }[]; liveTurn?: { runId: string } };
          if (found.liveTurn?.runId !== runId) {
            const reply = found.messages.filter((message) => message.role === 'assistant' && message.runId === runId).at(-1);
            saved = reply?.content ?? '';
            interrupted = Boolean(reply?.interruptedReason);
          } else await wait();
        }
        const logged = events.filter((event) => event.type === 'content' && event.runId === runId).map((event) => event.delta ?? '').join('');
        return { runId, events, seqs, root, answer: saved || logged, logged, saved: saved ?? '', interrupted };
      };

      const treeId = () => {
        const id = world.treeId;
        if (typeof id !== 'string') throw new Error('there is no tree yet: approve a plan in an earlier stage');
        return id;
      };

      const act = async (action: FlowAction): Promise<{ outcome: string; reason?: string | undefined }> => {
        if ('approvePlan' in action) {
          const proposals = (await http.get('/plans', { params: { conversationId } })).data as { id: string; status: string; createdAt: string }[];
          const proposal = [...proposals].filter((entry) => entry.status === 'proposed').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
          if (!proposal) throw new Error(`the conversation has no plan waiting to be approved (${proposals.map((entry) => entry.status).join(', ') || 'no plans at all'})`);
          const approved = await http.post(`/plans/${proposal.id}/approve`, {}, { validateStatus: () => true });
          if (approved.status >= 300) throw new Error(`the plan would not be approved: ${(approved.data as { error?: string }).error ?? approved.status}`);
          for (;;) {
            await stopIfCancelled();
            const found = (await http.get(`/plans/${proposal.id}`)).data as { status: string; reason?: string; adopted?: { treeId: string; leafIds: Record<string, string> } };
            if (found.status === 'adopted' && found.adopted) {
              await remember({ treeId: found.adopted.treeId, leafIds: found.adopted.leafIds, proposalId: proposal.id });
              return { outcome: 'ok' };
            }
            if (found.status !== 'adopting' && found.status !== 'proposed') return { outcome: 'failed', reason: `adopting the plan ended ${found.status}${found.reason ? `: ${found.reason}` : ''}` };
            await wait();
          }
        }
        if ('runTree' in action) {
          const id = treeId();
          const launched = await http.post(`/trees/${id}/run`, {}, { validateStatus: () => true });
          if (launched.status >= 300) throw new Error(`the tree would not run: ${(launched.data as { error?: string }).error ?? launched.status}`);
          for (;;) {
            await stopIfCancelled();
            const status = (await http.get(`/trees/${id}/run`)).data as { state: string; reason?: string };
            if (status.state === 'finished') return { outcome: 'ok' };
            if (status.state === 'failed') return { outcome: 'failed', reason: status.reason };
            await wait();
          }
        }
        if ('waitQuiet' in action) {
          for (;;) {
            await stopIfCancelled();
            const state = ((await http.get(`/conversations/${conversationId}/workspace`)).data as { state: string }).state;
            if (state === 'none') return { outcome: 'ok' };
            await wait();
          }
        }
        if ('deleteTree' in action) {
          const id = treeId();
          const removed = await http.delete(`/trees/${encodeURIComponent(id)}`, { validateStatus: () => true });
          if (removed.status >= 300) throw new Error(`the tree would not be deleted: ${(removed.data as { error?: string }).error ?? removed.status}`);
          for (;;) {
            await stopIfCancelled();
            const state = await http.get(`/trees/${id}/workspace`, { validateStatus: () => true });
            if (state.status === 404 || (state.data as { state?: string }).state === 'none') return { outcome: 'ok' };
            await wait();
          }
        }
        if ('deleteProject' in action) {
          const id = world.projectId;
          if (typeof id !== 'string') throw new Error('the check has no project to delete');
          const removed = await http.delete(`/projects/${id}`, { data: { confirm: world.projectName }, validateStatus: () => true });
          if (removed.status >= 300) return { outcome: 'failed', reason: `the project would not be deleted: ${(removed.data as { error?: string; blockers?: string[] }).error ?? removed.status}${(removed.data as { blockers?: string[] }).blockers?.length ? ` (${(removed.data as { blockers: string[] }).blockers.join('; ')})` : ''}` };
          for (;;) {
            await stopIfCancelled();
            const preview = await http.get(`/projects/${id}/removal`, { validateStatus: () => true });
            if (preview.status === 404) return { outcome: 'ok' };
            const state = (preview.data as { state?: { state: string; reason?: string } }).state;
            if (state?.state === 'failed') return { outcome: 'failed', reason: `deleting the project stopped: ${state.reason}` };
            await wait();
          }
        }
        throw new Error(`a stage cannot do ${Object.keys(action).join(', ')}`);
      };

      const openArtifacts = async (findings: string) => Promise.all([...findings.matchAll(/!?\[([^\]\n]+)\]\(\/api\/artifacts\/([0-9a-f-]+)\)/g)].map(async ([, name, id]) => {
        const res = await http.get(`/artifacts/${id}`, { responseType: 'arraybuffer', validateStatus: () => true });
        const size = (res.data as ArrayBuffer | undefined)?.byteLength ?? 0;
        return { name: name!, opens: res.status === 200 && size > 0, contentType: String(res.headers['content-type'] ?? ''), size };
      }));
      const workspaceOf = (of: 'tree' | 'conversation') => (of === 'tree' ? treeWorkspaceRunId(treeId()) : conversationWorkspaceRunId(conversationId));

      const readFile = async (workspace: string, candidates: string[], ref?: string): Promise<string | null> => {
        for (let tries = 0; tries < 20; tries += 1) {
          for (const path of candidates) {
            const found = await http.get(`/documents/${encodeURIComponent(workspace)}`, { params: { path, ...(ref ? { at: ref } : {}) }, validateStatus: () => true });
            if (found.status === 200) return (found.data as { content: string }).content;
          }
          await wait();
        }
        return null;
      };

      const observeFlow = async (expect: ScenarioExpectations, requestsBefore: number, ran?: Awaited<ReturnType<typeof chat>>): Promise<ObservedFlow> => {
        const flow: ObservedFlow = {};
        if (expect.modelSaw) {
          const requests = ((await http.get('/checks/model-requests')).data as { requests: { text: string }[] }).requests;
          flow.modelRequests = requests.slice(requestsBefore).map((request) => request.text);
        }
        if (expect.compacted !== undefined) {
          flow.compacted = Boolean(ran?.events.some((event) => event.type === 'notice' && (event.message ?? '').startsWith('the conversation was summarised')));
        }
        if (expect.summaryKept !== undefined) {
          const compaction = ((await http.get(`/conversations/${conversationId}`)).data as { compaction?: { through: number } }).compaction;
          if (compaction) flow.summary = { through: compaction.through };
        }
        if (expect.interrupted !== undefined && ran) {
          const full = ((await http.get(`/turns/${ran.runId}`, { params: { after: 0 } })).data as { entries: { events: LoggedEvent[] }[] }).entries.flatMap((entry) => entry.events);
          const logged = full.filter((event) => event.type === 'content' && event.runId === ran.runId).map((event) => event.delta ?? '').join('');
          flow.kept = { interrupted: ran.interrupted, chars: ran.saved.length, loggedChars: logged.length, prefix: logged.startsWith(ran.saved) };
        }
        if (expect.turnLog && ran) {
          const full = ((await http.get(`/turns/${ran.runId}`, { params: { after: 0 } })).data as { entries: { seq: number; events: LoggedEvent[] }[] }).entries;
          const seqs = full.map((entry) => entry.seq);
          const logged = full.flatMap((entry) => entry.events).filter((event) => event.type === 'content' && event.runId === ran.runId).map((event) => event.delta ?? '').join('');
          flow.turnLog = { entries: seqs.length, contiguous: seqs.every((seq, index) => seq === index + 1), savedMatches: Boolean(ran.saved) && logged.endsWith(ran.saved) };
        }
        if (expect.leaves) {
          const leaves = (await http.get('/leaves')).data as { title: string; status: string; verified?: boolean; landed?: { outcome: string }; findings?: string }[];
          flow.leaves = await Promise.all(leaves.map(async (leaf) => ({
            title: leaf.title,
            status: leaf.status,
            verified: leaf.verified === true,
            ...(leaf.landed ? { landed: leaf.landed.outcome } : {}),
            ...(leaf.findings ? { findings: leaf.findings } : {}),
            ...(expect.leaves?.artifacts?.[leaf.title] !== undefined ? { artifacts: await openArtifacts(leaf.findings ?? '') } : {}),
          })));
          flow.mergeTasks = ((await http.get('/engine/tasks')).data as { title: string }[]).filter((task) => task.title === CONFLICT_TASK_TITLE).length;
        }
        if (expect.repository) {
          const workspace = workspaceOf(expect.repository.of);
          flow.repository = {};
          for (const file of expect.repository.files) flow.repository[file.path] = await readFile(workspace, [file.path]);
        }
        if (expect.pullRequests) {
          const pulls = ((await http.get(`/trees/${treeId()}/pull-requests`)).data as { pullRequests: { state: string; merged: boolean }[] }).pullRequests;
          flow.pullRequests = {
            merged: pulls.filter((pull) => pull.merged).length,
            open: pulls.filter((pull) => pull.state === 'open').length,
            closedUnmerged: pulls.filter((pull) => pull.state === 'closed' && !pull.merged).length,
          };
        }
        if ((expect.exit !== undefined || expect.outputs) && ran) {
          const traces = ((await http.get(`/engine/runs/${ran.runId}/traces`)).data as { traces: { node?: string; nodeId?: string; exit?: string; outputs?: Record<string, unknown>; error?: string }[] }).traces;
          const traced = traces.filter((trace) => (trace.node ?? trace.nodeId) === STEP_NODE).at(-1);
          if (traced) flow.step = { ...(traced.exit ? { exit: traced.exit } : {}), ...(traced.outputs ? { outputs: traced.outputs } : {}), ...(traced.error ? { error: traced.error } : {}) };
        }
        if (expect.chooses && ran) {
          const traces = ((await http.get(`/engine/runs/${ran.runId}/traces`)).data as { traces: { kind?: string; outputs?: { reply?: { content?: string; toolCalls?: { name: string; arguments: string }[] } } }[] }).traces;
          const reply = traces.find((trace) => trace.kind === TURN_CALL_KIND && trace.outputs?.reply)?.outputs?.reply;
          if (reply) flow.turn = { content: reply.content ?? '', toolCalls: (reply.toolCalls ?? []).map((call) => ({ name: call.name, arguments: call.arguments })) } satisfies TurnReply;
        }
        if (expect.project) {
          const id = world.projectId;
          flow.projectExists = typeof id === 'string' && (await http.get(`/projects/${id}/removal`, { validateStatus: () => true })).status === 200;
        }
        if (expect.trees !== undefined) flow.trees = ((await http.get('/trees')).data as unknown[]).length;
        if (expect.workspace) {
          const path = expect.workspace.of === 'tree' ? `/trees/${treeId()}/workspace` : `/conversations/${conversationId}/workspace`;
          const state = await http.get(path, { validateStatus: () => true });
          flow.workspaceExists = state.status === 200 && (state.data as { state: string }).state !== 'none';
        }
        return flow;
      };

      const stages: { name: string; do: FlowAction; expect?: ScenarioExpectations | undefined }[] = [
        { name: 'the run', do: { chat: { message: scenario.input.message, agent: scenario.agent, inputs: scenario.input.inputs } }, expect: scenario.expect },
        ...(scenario.then ?? []),
      ];
      const checks: Check[] = [];
      let first: { runId: string; outcome: string; reason?: string | undefined; answer: string; calls: ToolCallLog[]; counters: Observed['counters']; procedure: { id: string; version: string } } | undefined;
      let tasks: Task[] = [];
      let stopped: string | undefined;

      for (const [index, stage] of stages.entries()) {
        const label = stages.length > 1 ? `${stage.name}: ` : '';
        const expect = stage.expect ?? {};
        try {
          const requestsBefore = scenario.script ? ((await http.get('/checks/model-requests')).data as { requests: unknown[] }).requests.length : 0;
          let observed: Observed;
          let ran: Awaited<ReturnType<typeof chat>> | undefined;
          if ('chat' in stage.do) {
            ran = await chat(stage.do.chat, index === 0);
            tasks = (await http.get('/engine/tasks')).data as Task[];
            const wanted = (expect.files ?? []).map((file) => file.path);
            const foundFiles: Record<string, string | null> = {};
            const agent = stage.do.chat.agent ?? scenario.agent;
            for (const path of wanted) foundFiles[path] = await readFile(conversationWorkspaceRunId(conversationId), [`${agent}/${ran.runId}/${path}`, path]);
            let effort: RunEffort | undefined;
            for (let tries = 0; tries < 20 && !effort; tries += 1) {
              effort = await store.findRunEffort(ran.runId);
              if (!effort) await wait();
            }
            const calls = observedCalls(ran.events);
            observed = {
              outcome: ran.root.outcome ?? 'unknown',
              ...(ran.root.reason ? { reason: ran.root.reason } : {}),
              calls,
              handOffs: observedHandOffs(ran.events, ran.runId),
              files: foundFiles,
              tasks,
              counters: { rounds: effort?.rounds ?? 0, toolCalls: effort?.toolCalls ?? calls.length, totalTokens: effort?.totalTokens ?? 0 },
              answer: ran.answer,
              saved: index === 0
                ? (await store.getProcedures(spaceId)).filter((source) => source.ownerId === spaceId && before.get(source.id) !== source.updatedAt).map((source): StoredProcedure => ({ id: source.id, source: source.source }))
                : [],
            };
            if (index === 0) {
              first = {
                runId: ran.runId, outcome: observed.outcome, ...(observed.reason ? { reason: observed.reason } : {}), answer: ran.answer, calls, counters: observed.counters,
                procedure: { id: effort?.procedureId ?? scenario.procedure.id, version: effort?.procedureVersion ?? '' },
              };
            }
          } else {
            const done = await act(stage.do);
            tasks = (await http.get('/engine/tasks')).data as Task[];
            observed = { outcome: done.outcome, ...(done.reason ? { reason: done.reason } : {}), calls: [], handOffs: [], files: {}, tasks, counters: { rounds: 0, toolCalls: 0, totalTokens: 0 }, answer: '', saved: [] };
            if (done.outcome !== 'ok' && expect.outcome === undefined) checks.push({ what: `${label}finishes ok`, passed: false, detail: `it finished ${done.outcome}${done.reason ? `: ${done.reason}` : ''}` });
          }
          observed.flow = await observeFlow(expect, requestsBefore, ran);
          const scored = await scoreScenario(expect, observed, {
            tools: args.tools,
            reported: (says, said) => deps.reported({ spaceId, runId: ran?.runId ?? first?.runId ?? spaceId, agent: scenario.agent, modelId: args.modelId }, says, said),
          });
          checks.push(...scored.map((check) => ({ ...check, what: `${label}${check.what}` })));
        } catch (err) {
          await stopIfCancelled();
          stopped = `${label}${(err as Error).message}`;
          checks.push({ what: `${label}runs to the end`, passed: false, detail: (err as Error).message });
          break;
        }
      }

      const firstRun = first ?? { runId: '', outcome: 'failed', reason: stopped, answer: '', calls: [], counters: { rounds: 0, toolCalls: 0, totalTokens: 0 }, procedure: { id: scenario.procedure.id, version: '' } };
      return {
        result: {
          scenarioId: scenario.id,
          name: scenario.name,
          runId: firstRun.runId,
          conversationId,
          procedure: firstRun.procedure,
          passed: !stopped && checks.length > 0 && checks.every((check) => check.passed),
          outcome: firstRun.outcome,
          ...(firstRun.reason ? { reason: firstRun.reason } : {}),
          answer: firstRun.answer,
          checks,
          calls: firstRun.calls.map((call) => ({ name: call.name, ok: call.ok, digest: call.digest.slice(0, 500) })),
          counters: firstRun.counters,
          tasks: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, ...(task.evidence ? { evidence: task.evidence } : {}) })),
          durationMs: Date.now() - startedAt,
          ...(stopped && !first ? { error: stopped } : {}),
        },
        runIds: [...runIds],
      };
    },

    async CheckSpaceGoneActivity({ spaceId }) {
      const [records, workspaces, giteaUser] = await Promise.all([deps.leftovers.records(spaceId), deps.leftovers.workspaces(spaceId), deps.leftovers.giteaUser(spaceId)]);
      return [
        ...Object.entries(records).map(([name, count]) => `${count} in ${name}`),
        ...workspaces.map((namespace) => `the workspace ${namespace}`),
        ...(giteaUser ? ['its Gitea user'] : []),
      ];
    },
  };
}

export interface CheckProgressStore {
  getEvalRecord<T>(collection: 'evalScenarioRuns', ownerId: string, id: string): Promise<T | null>;
  saveEvalRecord<T>(collection: 'evalScenarioRuns', record: T): Promise<void>;
}

export interface CheckProgressArgs {
  ownerId: string;
  checkRunId: string;
  running?: string | undefined;
  result?: ScenarioResult | undefined;
}

export function createCheckProgressActivity(store: CheckProgressStore) {
  return {
    async CheckProgressActivity({ ownerId, checkRunId, running, result }: CheckProgressArgs): Promise<void> {
      const record = await store.getEvalRecord<{ results: ScenarioResult[]; finished: number; running?: string }>('evalScenarioRuns', ownerId, checkRunId);
      if (!record) return;
      const results = result && !record.results.some((entry) => entry.scenarioId === result.scenarioId) ? [...record.results, result] : record.results;
      const { running: _was, ...rest } = record;
      await store.saveEvalRecord('evalScenarioRuns', { ...rest, results, finished: results.length, ...(running ? { running } : {}) });
    },
  };
}
