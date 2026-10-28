import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  startChild,
  getExternalWorkflowHandle,
  CancellationScope,
  ActivityCancellationType,
  continueAsNew,
  workflowInfo,
  patched,
  ActivityFailure,
} from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { childInputs } from '../engine-host/nodes/child-inputs.js';
import {
  WORKFLOW_IMPLEMENTATIONS,
  createNodeExecutor,
  createOrchestrationNodes,
  definitionFor,
  runProcedure,
  stepImplementation,
  valueImplementation,
  type ChildOutcomeValue,
  type ExternalAgentCall,
  type NodeExecutor,
  type NodeImplementation,
  type NodeRequest,
  type NodeTrace,
  type OrchestrationPorts,
  type StepResult,
  type ValueResult,
} from '@koala/agent-engine/procedure';
import { createEventBus, type EngineEvent } from '@koala/agent-engine/workflow';
import {
  DEFAULT_STREAM_TASK_QUEUE,
  deviceQueue,
  handleFor,
  launchFor,
  ticketFor,
  turnOf,
  type AgentRunOutcome,
  type LifecycleEvent,
  type ProcedureRunInput,
  type RunContinuation,
  type PublishArgs,
  type RecordTracesArgs,
  type SettleClaimsArgs,
  type ToolAllowedArgs,
  type AutoModeArgs,
  type RemoteNodeRequest,
  type RemoteNodeResult,
  type ResolveAgentArgs,
  type ResolvedAgentInfo,
  type ToolCallArgs,
  type ToolCallOutcome,
} from '../engine-host/temporal/contracts.js';
import type { RunLimits, RunLimitsArgs } from '../engine-host/registries/effort.js';
import { RUN_STATE_QUERY, type RunState } from '../engine-host/temporal/run-cancellation.js';
import { ASK_CHARS, collectStep, machineChoice, RUN_IN_WORKSPACE, UNNAMED_MACHINE, type Artifact, type RunEffort, type RunStep } from '@koala/agent-engine/procedure';
import { platformCatalogue, platformGroups } from '../extensions/installed.js';
import { ownerIn, startedFor } from '../platform/lib/workflow-owner.js';
import { tracedSummary } from '../engine/lib/turn-log.js';
import { externalCallId, externalRunEvents, externalToolName, permissionChoice, type ExternalToolSeen } from '../machines/lib/external-agent-events.js';
import type { ExternalAgentStepArgs, ExternalAgentStepResult, ExternalCallAnswer, ExternalToolCall, MachineGitOp, MachineGitResult } from '@koala/engine-core';
import { machineBranch, machineFolder, machineStepFolder } from '../machines/lib/machine-branches.js';
import type { MachineSendRequest, MachineWorkRequest } from '../engine-host/sandboxes/machine-work.js';
import type { BroughtBack } from '../engine-host/sandboxes/workspace-documents.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';

export const CONTINUE_AFTER_EVENTS = 10_000;

interface EngineRemote {
  EngineNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
  EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome>;
  EngineMachineSendActivity(args: MachineSendRequest): Promise<{ repo: string; folder: string; commit: string }>;
  EngineMachineTakeActivity(args: MachineWorkRequest & { message?: string | undefined }): Promise<BroughtBack>;
  EngineMachineKeepActivity(args: MachineWorkRequest): Promise<{ kept: true; commit: string } | { kept: false; why: string }>;
  EngineMachineDropActivity(args: MachineWorkRequest): Promise<void>;
  EngineMachineNameActivity(args: { ownerId: string; deviceId: string }): Promise<string | null>;
}

interface DeviceRemote {
  ExternalAgentActivity(args: ExternalAgentStepArgs): Promise<ExternalAgentStepResult>;
  MachineGitActivity(op: MachineGitOp): Promise<MachineGitResult>;
}

interface StreamRemote {
  EngineStreamNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
}

const ABANDON = ActivityCancellationType.ABANDON;
const TRY_CANCEL = ActivityCancellationType.TRY_CANCEL;
const toolCalls = proxyActivities<Pick<EngineRemote, 'EngineToolActivity'>>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY, cancellationType: TRY_CANCEL });
const engine = proxyActivities<EngineRemote>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY, cancellationType: ABANDON });
const engineNodes = proxyActivities<EngineRemote>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY, cancellationType: ABANDON });
const engineNodesOnce = proxyActivities<EngineRemote>({ retry: { maximumAttempts: 1 }, ...LIVE_ACTIVITY, cancellationType: ABANDON });
const stream = proxyActivities<StreamRemote>({ taskQueue: DEFAULT_STREAM_TASK_QUEUE, retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY, cancellationType: ABANDON });
const streamOnce = proxyActivities<StreamRemote>({ taskQueue: DEFAULT_STREAM_TASK_QUEUE, retry: { maximumAttempts: 1 }, ...LIVE_ACTIVITY, cancellationType: ABANDON });

const { EngineRecordTracesActivity, EngineRunLimitsActivity, EngineRecordEffortActivity, EngineSettleClaimsActivity, EngineToolAllowedActivity, EngineAutoModeActivity } = proxyActivities<{
  EngineToolAllowedActivity(args: ToolAllowedArgs): Promise<boolean>;
  EngineAutoModeActivity(args: AutoModeArgs): Promise<boolean>;
  EngineRecordTracesActivity(args: RecordTracesArgs): Promise<void>;
  EngineRunLimitsActivity(args: RunLimitsArgs): Promise<RunLimits>;
  EngineRecordEffortActivity(effort: RunEffort): Promise<void>;
  EngineSettleClaimsActivity(args: SettleClaimsArgs): Promise<string[]>;
}>({
  retry: { maximumAttempts: 3 },
  ...LIVE_ACTIVITY,
});

const { EnginePublishActivity, EngineLifecycleActivity } = proxyActivities<{
  EnginePublishActivity(args: PublishArgs): Promise<void>;
  EngineLifecycleActivity(event: LifecycleEvent): Promise<void>;
}>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: { maximumAttempts: 3 },
  ...LIVE_ACTIVITY,
});

const CONCLUSIONS = 'conclusion-events';
const CONVERSATION_APPROVALS = 'conversation-approvals';
const HAND_OFFS_TOGETHER = 'hand-offs-together';
const TOOL_CALLS_HEAR_STOPS = 'tool-calls-hear-stops';
const SANDBOX_CALLS_UNASKED = 'sandbox-calls-unasked';
const AUTO_MODE = 'auto-mode';
const ANSWERS_TAKEN_ONCE = 'answers-taken-once';
const READS_TOGETHER = 'reads-together';
const MACHINE_NAMES = 'machine-names';
const MACHINE_MERGES = 'machine-merges';
const MACHINE_ANSWER_WAIT_MS = 15_000;
const MACHINE_GATHER_MS = 1_000;

export const approveSignal = defineSignal<[{ callId: string; allowed: boolean; forRun?: boolean }]>('approve');
export const answerSignal = defineSignal<[{ nodeId: string; value: unknown }]>('answer');
export const cancelSignal = defineSignal<[]>('cancelRun');
export const stateQuery = defineQuery<RunState>(RUN_STATE_QUERY);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toRemote = (request: NodeRequest): RemoteNodeRequest => ({
  node: request.node,
  origin: request.origin,
  inputs: request.inputs,
  ...(request.previous ? { previous: { ...request.previous } } : {}),
  execution: request.execution,
  run: {
    identity: request.run.identity,
    launch: request.run.launch,
    handles: request.run.handles,
    inputs: request.run.inputs,
    counters: { ...request.run.counters },
    budget: request.run.budget,
    cleaningUp: request.run.cleaningUp,
    ...(request.run.ending ? { ending: request.run.ending } : {}),
  },
});

export async function AgentRunWorkflow(input: ProcedureRunInput): Promise<AgentRunOutcome> {
  const { ticket, procedure } = input;
  const catalogue = platformCatalogue();
  const conversationId = typeof input.inputs.conversationId === 'string' && ticket.depth === 0 ? input.inputs.conversationId : undefined;
  const item = input.inputs.item as { leafId?: unknown } | undefined;
  const leafId = typeof item?.leafId === 'string' ? item.leafId : undefined;
  const conclude = async (event: LifecycleEvent): Promise<void> => {
    await EngineLifecycleActivity(event).catch(() => undefined);
  };

  const { continued } = input;
  const approvals = new Map<string, boolean>(continued?.approvals ?? []);
  const answers = new Map<string, unknown>(continued?.answers ?? []);
  let approvedForRun = continued?.approvedForRun ?? false;
  const asking = new Set<string>();
  const waitsFor = new Set<string>();
  let cancelled = false;
  let currentNode: string | undefined;
  let rounds = continued?.checkpoint.counters.rounds ?? 0;
  let children = continued?.children ?? 0;
  let externals = 0;
  const produced: Artifact[] = [...(continued?.produced ?? [])];
  let steps: RunStep[] = [...(continued?.steps ?? [])];
  const placedOnly = <T extends { artifacts?: Artifact[] | undefined }>(outcome: T): T => {
    const artifacts = outcome.artifacts?.filter((artifact) => artifact.kind === 'link' || typeof artifact.workspace === 'string');
    const { artifacts: _dropped, ...rest } = outcome;
    return (artifacts?.length ? { ...rest, artifacts } : rest) as T;
  };
  const keep = (artifacts: readonly Artifact[] | undefined): void => {
    for (const artifact of artifacts ?? []) {
      const key = JSON.stringify(artifact);
      if (!produced.some((known) => JSON.stringify(known) === key)) produced.push(artifact);
    }
  };

  setHandler(approveSignal, ({ callId, allowed, forRun }) => {
    approvals.set(callId, allowed);
    if (allowed && forRun) approvedForRun = true;
  });
  setHandler(answerSignal, ({ nodeId, value }) => { answers.set(nodeId, value); });
  const inFlight = new Set<CancellationScope>();
  const runningChildren = new Set<string>();
  const cancelRun = () => {
    if (cancelled) return;
    cancelled = true;
    for (const childId of runningChildren) {
      void getExternalWorkflowHandle(childId).signal(cancelSignal).catch(() => undefined);
    }
  };
  void CancellationScope.nonCancellable(() => condition(() => cancelled)).then(() => {
    for (const scope of inFlight) scope.cancel();
  });
  const cancellable = async <T>(work: () => Promise<T>): Promise<T> => {
    const scope = new CancellationScope();
    inFlight.add(scope);
    try {
      return await scope.run(work);
    } finally {
      inFlight.delete(scope);
    }
  };
  setHandler(cancelSignal, cancelRun);
  CancellationScope.current().cancelRequested.catch(cancelRun);
  setHandler(stateQuery, () => ({ ...(currentNode ? { nodeId: currentNode } : {}), rounds, cancelled, ...(asking.size > 0 ? { asking: [...asking] } : {}), ...(waitsFor.size > 0 ? { waitsFor: [...waitsFor] } : {}) }));

  const pending: EngineEvent[] = [];
  const traces: NodeTrace[] = [];
  const bus = createEventBus({ retain: 0 });
  bus.subscribe((event) => {
    if (event.type === 'thinking' || event.type === 'content') return;
    if (event.type === 'node.entered') currentNode = event.nodeId;
    if (event.type === 'tool.called' || event.type === 'tool.result') steps = collectStep(steps, event);
    pending.push(event);
  });

  const flush = async (): Promise<void> => {
    if (pending.length > 0) await EnginePublishActivity({ ownerId: ticket.ownerId, turnId: turnOf(ticket), events: pending.splice(0, pending.length) });
    if (traces.length > 0) {
      await EngineRecordTracesActivity({
        ownerId: ticket.ownerId,
        runId: ticket.runId,
        agentSlug: ticket.agentSlug,
        procedureId: procedure.id,
        procedureVersion: procedure.version,
        traces: traces.splice(0, traces.length),
      });
    }
  };

  const publishNow = async (event: Omit<EngineEvent, 'runId' | 'at'>): Promise<void> => {
    bus.emit({ ...event, runId: ticket.runId, at: new Date(Date.now()).toISOString() } as EngineEvent);
    await flush();
  };

  const ports: OrchestrationPorts = {
    async runTool({ nodeId, call, persona, environment, run }) {
      const handle = handleFor(environment);
      const args: ToolCallArgs = {
        ticket: ticketFor(run),
        nodeId,
        name: call.name,
        arguments: call.arguments,
        callId: call.id,
        granted: persona.tools,
        ...(handle ? { environment: handle } : {}),
      };

      const hearsStops = patched(TOOL_CALLS_HEAR_STOPS);
      if (environment?.kind === 'machine') {
        const onDevice = proxyActivities<Pick<EngineRemote, 'EngineToolActivity'>>({
          cancellationType: hearsStops ? TRY_CANCEL : ABANDON,
          taskQueue: deviceQueue(environment.deviceId),
          retry: ACTIVITY_RETRY,
          ...LIVE_ACTIVITY,
        });
        const outcome = placedOnly(await cancellable(() => onDevice.EngineToolActivity(args)));
        keep(outcome.artifacts);
        return outcome;
      }

      const outcome = await cancellable(() => (hearsStops ? toolCalls : engine).EngineToolActivity(args));
      keep(outcome.artifacts);
      return outcome;
    },

    async runExternal({ nodeId, agent, brief, context, mode, model, resume, tools, callTool, environment, workspace, run }) {
      externals += 1;
      const key = `${ticket.runId}:${nodeId}:${externals}`;
      const device = proxyActivities<DeviceRemote>({
        taskQueue: deviceQueue(environment.deviceId),
        retry: { maximumAttempts: 1 },
        ...LIVE_ACTIVITY,
        cancellationType: ABANDON,
      });
      const machineName = environment.deviceName === UNNAMED_MACHINE && patched(MACHINE_NAMES)
        ? (await engine.EngineMachineNameActivity({ ownerId: ticket.ownerId, deviceId: environment.deviceId })) ?? environment.deviceName
        : environment.deviceName;
      const work: MachineWorkRequest | undefined = workspace
        ? { ownerId: ticket.ownerId, workspaceRunId: workspace.workspace.runId, ...(workspace.worktree ? { worktree: workspace.worktree } : {}), branch: machineBranch(environment.deviceId, key) }
        : undefined;
      let checkout: { repo: string; folder: string; path: string } | undefined;
      const gitOnDevice = (op: MachineGitOp): Promise<MachineGitResult> => device.MachineGitActivity(op).catch((err: unknown) => {
        if (!(err instanceof ActivityFailure)) throw err;
        return { ok: false, error: `${machineName} could not reach the project's work: ${err.cause?.message ?? err.message}` };
      });
      const merging = Boolean(work) && patched(MACHINE_MERGES);
      const notice = (message: string): void => {
        bus.emit({ type: 'notice', level: 'warn', nodeId, message, runId: ticket.runId, at: new Date(Date.now()).toISOString() } as EngineEvent);
      };
      type Back = { ok: true } | { ok: false; why: string; conflicts?: string[] | undefined; unresolved?: string[] | undefined };
      const bringBack = async (message: string): Promise<Back> => {
        if (!work || !checkout) return { ok: true };
        const pushed = await gitOnDevice({ kind: 'push', repo: checkout.repo, branch: work.branch, folder: checkout.folder, message });
        if (!pushed.ok) return { ok: false, why: pushed.error, ...(pushed.unresolved ? { unresolved: pushed.unresolved } : {}) };
        const taken = await engine.EngineMachineTakeActivity({ ...work, ...(merging ? { message: `Merge ${agent}'s work from ${machineName}` } : {}) });
        if (!taken.brought) return { ok: false, why: `the work on ${machineName} could not be brought back into the workspace: ${taken.why}`, ...(taken.conflicts ? { conflicts: taken.conflicts } : {}) };
        if (taken.set) notice(`What the workspace had uncommitted when ${agent}'s work came back was set aside in a stash (${taken.set}).`);
        return { ok: true };
      };
      const mergeIn = async (): Promise<{ ok: true; conflicts: string[] } | { ok: false; why: string }> => {
        if (!work || !checkout) return { ok: false, why: 'there is no work to merge' };
        const now = { ...work, branch: `${work.branch}-workspace` };
        await engine.EngineMachineSendActivity({ ...now, message: `What the workspace has now, for ${agent} on ${machineName} to merge` });
        const merged = await gitOnDevice({ kind: 'merge', repo: checkout.repo, branch: now.branch, folder: checkout.folder });
        await engine.EngineMachineDropActivity(now);
        if (!merged.ok) return { ok: false, why: merged.error };
        if (!merged.conflicts) return { ok: false, why: `the machine agent on ${machineName} is older than this Koala and cannot merge; run the command from My Machines on it again to update it` };
        return { ok: true, conflicts: merged.conflicts };
      };
      const toMerge = (conflicts: string[]): string => conflicts.length
        ? `Other work came into the workspace while you worked, and it is now merged into your folder. These files conflict: ${conflicts.join(', ')}. Resolve each conflict so that both your work and the other work are kept, remove every conflict marker, and commit the merge.`
        : 'Other work came into the workspace while you worked, and it is now merged into your folder without conflicts. Check that your work still holds with it, and commit anything you change.';
      const keepWork = async (why: string): Promise<string> => {
        if (!work || !checkout) return why;
        const pushed = await gitOnDevice({ kind: 'push', repo: checkout.repo, branch: work.branch, folder: checkout.folder, message: `${agent}'s work on ${machineName}, kept as it was`, keep: true });
        const kept = pushed.ok ? await engine.EngineMachineKeepActivity(work) : { kept: false as const, why: pushed.error };
        if (!kept.kept) return `${why}; its work is still in ${checkout.path} on ${machineName}, and could not be kept in the workspace: ${kept.why}`;
        notice(`${agent}'s work on ${machineName} could not be merged into the workspace (${why}). Nothing is lost: it is kept as the branch ${work.branch} in the workspace.`);
        return `${why}; ${agent}'s work is kept as the branch ${work.branch} in the workspace`;
      };
      if (work) {
        const sent = await engine.EngineMachineSendActivity({
          ...work,
          message: `Work so far, before ${agent} on ${machineName} takes it`,
          start: { ticket, environment: handleFor(workspace) },
        });
        const folder = merging ? machineStepFolder(work.workspaceRunId, sent.folder, key) : machineFolder(work.workspaceRunId, sent.folder);
        const fetched = await gitOnDevice({ kind: 'checkout', repo: sent.repo, branch: work.branch, folder });
        if (!fetched.ok) {
          await engine.EngineMachineDropActivity(work);
          return { outcome: 'failed', text: '', reason: fetched.error };
        }
        checkout = { repo: sent.repo, folder, path: fetched.path };
      }
      const seen: ExternalToolSeen = { called: new Set(), settled: new Set() };
      let text = '';
      let thinking = '';
      const calls = new Map<string, ExternalAgentCall>();
      const take = async (result: ExternalAgentStepResult): Promise<void> => {
        const logged = externalRunEvents(agent, nodeId, result.events, seen);
        text += logged.text;
        for (const event of logged.events) {
          if (event.type === 'thinking') thinking += event.delta;
          else if (event.type === 'tool.called') calls.set(event.callId, { callId: event.callId, name: event.name, args: event.args });
          else if (event.type === 'tool.result') {
            const called = calls.get(event.callId);
            if (called) calls.set(event.callId, { ...called, ok: event.ok, digest: event.digest });
          }
        }
        const streamed = logged.events.filter((event) => event.type === 'content' || event.type === 'thinking');
        if (streamed.length > 0) {
          const at = new Date(Date.now()).toISOString();
          await EnginePublishActivity({ ownerId: ticket.ownerId, turnId: turnOf(ticket), events: streamed.map((event) => ({ ...event, runId: ticket.runId, at })) as EngineEvent[] });
        }
        for (const event of logged.events) {
          if (event.type !== 'content' && event.type !== 'thinking') bus.emit({ ...event, runId: ticket.runId, at: new Date(Date.now()).toISOString() } as EngineEvent);
        }
        await flush();
      };
      const step = (op: ExternalAgentStepArgs['op']): Promise<ExternalAgentStepResult> => device.ExternalAgentActivity({ key, agent, op }).catch((err: unknown) => {
        if (!(err instanceof ActivityFailure)) throw err;
        return { state: 'failed', error: `${environment.deviceName} could not run ${agent}: ${err.cause?.message ?? err.message}`, events: [] };
      });

      let result = await step({
        kind: 'open', brief,
        ...(context ? { context } : {}), ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(resume ? { resume } : {}),
        ...(checkout ? { path: checkout.path } : environment.path ? { path: environment.path } : {}), ...(tools?.length ? { tools } : {}),
      });
      let ranOn = result.model;
      const answers: ExternalCallAnswer[] = [];
      const answering = new Map<string, Promise<void>>();
      let inWorkspace: Promise<unknown> = Promise.resolve();
      let broke: unknown;
      const unsyncedFor = async (): Promise<string | undefined> => {
        const back = await bringBack(`Work so far, for ${RUN_IN_WORKSPACE}`);
        if (back.ok) return undefined;
        if (!merging) return back.why;
        if (back.conflicts) {
          const merged = await mergeIn();
          return merged.ok ? `${toMerge(merged.conflicts)} Then call ${RUN_IN_WORKSPACE} again.` : back.why;
        }
        if (back.unresolved) return `${back.why}. Resolve them so that both sides are kept, commit, then call ${RUN_IN_WORKSPACE} again.`;
        return back.why;
      };
      const answer = async (call: ExternalToolCall): Promise<ExternalCallAnswer> => {
        const unsynced = !cancelled && callTool && call.name === RUN_IN_WORKSPACE ? await unsyncedFor() : undefined;
        const answered = cancelled || !callTool
          ? { ok: false, content: cancelled ? 'the run was cancelled' : 'no tools are offered here' }
          : unsynced ? { ok: false, content: unsynced } : await callTool(call);
        calls.set(call.callId, {
          callId: call.callId, name: call.name, args: call.arguments, ok: answered.ok, digest: answered.content,
          ...('artifacts' in answered && answered.artifacts?.length ? { artifacts: answered.artifacts } : {}),
          ...('child' in answered && answered.child ? { child: answered.child } : {}),
        });
        return { callId: call.callId, ok: answered.ok, content: answered.content };
      };
      const start = (call: ExternalToolCall): void => {
        const running = call.name === RUN_IN_WORKSPACE ? inWorkspace.then(() => answer(call)) : answer(call);
        if (call.name === RUN_IN_WORKSPACE) inWorkspace = running.catch(() => undefined);
        answering.set(call.callId, running.then(
          (done) => { answers.push(done); },
          (err: unknown) => { broke ??= err; },
        ).finally(() => { answering.delete(call.callId); }));
      };
      const drive = async (from: ExternalAgentStepResult): Promise<ExternalAgentStepResult> => {
        let at = from;
        for (;;) {
          await take(at);
          if (broke !== undefined) throw broke;
          if (at.state === 'ended' || at.state === 'failed' || at.state === 'closed') return at;
          if (cancelled) {
            at = await step({ kind: 'cancel' });
            continue;
          }
          if (at.state === 'calls') {
            if (!Array.isArray(at.calls)) {
              return { ...at, state: 'failed', error: `the machine agent on ${machineName} is older than this Koala; run the command from My Machines on it again to update it`, events: [] };
            }
            for (const call of at.calls) start(call);
            at = await step({ kind: 'continue', within: MACHINE_GATHER_MS });
            ranOn = at.model ?? ranOn;
            continue;
          }
          if (at.state === 'asks') {
            const { ask } = at;
            ranOn = at.model ?? ranOn;
            const allowed = await ports.approve({
              nodeId,
              call: { id: externalCallId(ask.tool.callId), name: externalToolName(agent, ask.tool), arguments: ask.tool.title },
              environment: workspace ?? environment,
              on: machineName,
              run,
            });
            at = await step({ kind: 'answer', optionId: cancelled ? undefined : permissionChoice(ask, allowed) });
            continue;
          }
          if (answers.length === 0 && answering.size > 0) await condition(() => answers.length > 0 || broke !== undefined || cancelled, MACHINE_ANSWER_WAIT_MS);
          if (broke !== undefined) throw broke;
          at = await step(answers.length > 0 && !cancelled ? { kind: 'results', results: answers.splice(0) } : { kind: 'continue' });
          ranOn = at.model ?? ranOn;
        }
      };
      const settle = async (): Promise<string | undefined> => {
        const message = `${agent} on ${machineName}: ${brief.split('\n')[0]!.slice(0, 72)}`;
        let lastUnresolved: string | undefined;
        for (;;) {
          const back = await bringBack(message);
          if (back.ok) return undefined;
          if (result.state !== 'ended' || cancelled) return keepWork(back.why);
          let ask: string;
          if (back.conflicts) {
            const merged = await mergeIn();
            if (!merged.ok) return keepWork(merged.why);
            ask = toMerge(merged.conflicts);
          } else if (back.unresolved) {
            const still = back.unresolved.join(', ');
            if (still === lastUnresolved) return keepWork(back.why);
            lastUnresolved = still;
            ask = `${back.why}. Resolve them so that both sides are kept, remove every conflict marker, and commit.`;
          } else {
            return keepWork(back.why);
          }
          result = await drive(await step({ kind: 'prompt', text: ask }));
          await Promise.all(answering.values());
          if (broke !== undefined) throw broke;
        }
      };

      result = await drive(result);
      await Promise.all(answering.values());
      if (broke !== undefined) throw broke;
      let notBack: string | undefined;
      if (merging) {
        notBack = await settle();
        if (result.state !== 'failed') await take(await step({ kind: 'close' }));
      } else {
        if (result.state !== 'failed') await take(await step({ kind: 'close' }));
        const back = cancelled ? { ok: true as const } : await bringBack(`${agent} on ${machineName}: ${brief.split('\n')[0]!.slice(0, 72)}`);
        notBack = back.ok ? undefined : back.why;
      }
      const { identity, sessionId } = result;
      const on = result.model ?? ranOn;
      const withModel = { ...(on ? { model: on } : {}), ...(thinking.trim() ? { thinking } : {}), ...(calls.size ? { calls: [...calls.values()] } : {}) };
      if (work) await engine.EngineMachineDropActivity(work);
      if (merging && checkout && !notBack) await gitOnDevice({ kind: 'remove', folder: checkout.folder });
      if (notBack) return { outcome: 'failed', text, reason: notBack, ...(identity ? { identity } : {}), ...(sessionId ? { sessionId } : {}), ...withModel };

      if (result.state === 'failed') return { outcome: 'failed', text, reason: result.error, ...(identity ? { identity } : {}), ...(sessionId ? { sessionId } : {}), ...withModel };
      if (result.state !== 'ended' || !identity || !sessionId) return { outcome: 'failed', text, reason: 'the agent\'s session closed before its turn ended', ...withModel };
      if (result.state === 'ended' && result.stopReason === 'end_turn') return { outcome: 'finished', stopReason: result.stopReason, text, identity, sessionId, ...withModel };
      return { outcome: 'stopped', stopReason: result.stopReason, text, identity, sessionId, reason: cancelled ? 'the run was cancelled' : `its turn ended: ${result.stopReason}`, ...withModel };
    },

    handOffsTogether: () => patched(HAND_OFFS_TOGETHER),
    sandboxCallsUnasked: () => patched(SANDBOX_CALLS_UNASKED),
    readsTogether: () => patched(READS_TOGETHER),

    async runChild({ agent, inputs, environment, run, callId }): Promise<ChildOutcomeValue> {
      children += 1;
      const childRunId = `${ticket.runId}-${agent}-${children}`;
      const handed = ticket.modelReach === 'chat' ? undefined : run.launch.modelId;
      const inherited = machineChoice(handed) ? undefined : handed;
      const resolved = await engine.EngineResolveAgentActivity({ ownerId: ticket.ownerId, agentSlug: agent, turnId: turnOf(ticket), ...(handed ? { modelId: handed, handedDown: true } : {}) });
      const childModel = resolved.machine ?? (resolved.tree ? resolved.tree.modelId : inherited);

      if (!resolved.found || !resolved.procedure) {
        return { runId: childRunId, agentId: agent, outcome: 'failed', reason: `there is no agent called "${agent}"`, outputs: {} };
      }
      if (ticket.actingFor && (resolved.machine || machineChoice(childModel))) {
        return { runId: childRunId, agentId: agent, outcome: 'failed', reason: `${agent} runs on the owner's machine, and work done for ${ticket.actingFor.email}, a member of a shared project, never goes there`, outputs: {} };
      }

      if (cancelled) return { runId: childRunId, agentId: agent, outcome: 'interrupted', reason: 'the run was cancelled', outputs: {} };

      const started = await startChild(AgentRunWorkflow, {
        workflowId: childRunId,
        ...startedFor(ownerIn(workflowInfo().typedSearchAttributes) ?? ticket.ownerId),
        args: [{
          ticket: {
            ...ticketFor(run),
            runId: childRunId,
            parentRunId: ticket.runId,
            parentCallId: callId,
            turnId: turnOf(ticket),
            depth: ticket.depth + 1,
            agentSlug: agent,
            trigger: 'agent',
            modelId: childModel,
            inPlace: resolved.inPlace === true,
            ...(ticket.modelReach ? { modelReach: ticket.modelReach } : {}),
          },
          procedure: resolved.procedure,
          inputs: childInputs(inputs),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(environment && environment.kind !== 'machine' && (!resolved.machine || resolved.inPlace) ? { environment } : {}),
          ...(input.continueAfterEvents ? { continueAfterEvents: input.continueAfterEvents } : {}),
        }],
      });
      runningChildren.add(childRunId);
      if (cancelled) await started.signal(cancelSignal);
      const child = await started.result().finally(() => runningChildren.delete(childRunId));
      keep(child.artifacts);

      return {
        runId: child.runId,
        agentId: agent,
        outcome: child.outcome,
        ...(child.reason ? { reason: child.reason } : {}),
        outputs: child.outputs,
        ...(child.artifacts?.length ? { artifacts: child.artifacts } : {}),
        steps: child.steps ?? [],
      };
    },

    async approve({ nodeId, call, environment, on }) {
      if (approvedForRun) return true;
      if (patched(AUTO_MODE) && !ticket.actingFor) {
        const workspaceRunId = environment?.kind === 'sandbox' ? environment.workspace.runId : undefined;
        if (await EngineAutoModeActivity({
          ownerId: ticket.ownerId,
          agentSlug: ticket.agentSlug,
          ...(ticket.conversationId && !ticket.actingFor ? { conversationId: ticket.conversationId } : {}),
          ...(workspaceRunId ? { workspaceRunId } : {}),
        })) return true;
      }
      if (ticket.conversationId && !ticket.actingFor && patched(CONVERSATION_APPROVALS)) {
        if (await EngineToolAllowedActivity({ ownerId: ticket.ownerId, conversationId: ticket.conversationId, tool: call.name })) return true;
      }

      const where = on ?? (environment?.kind === 'machine' ? environment.deviceName : 'this run');
      await publishNow({
        type: 'notice',
        level: 'warn',
        nodeId,
        callId: call.id,
        tool: call.name,
        message: `${ticket.agentSlug} wants to run ${call.name} on ${where}${ticket.actingFor ? `, asked by ${ticket.actingFor.email}` : ''}: ${call.arguments}`,
      } as never);

      asking.add(call.id);
      await condition(() => approvals.has(call.id) || cancelled);
      asking.delete(call.id);
      if (cancelled) return false;
      return approvals.get(call.id) === true;
    },

    async ask({ nodeId, timeoutMs, choices }) {
      const usable = (): boolean => {
        if (!answers.has(nodeId)) return false;
        const value = answers.get(nodeId);
        return !choices?.length || (typeof value === 'string' && choices.includes(value));
      };
      await flush();
      waitsFor.add(nodeId);
      const answered = timeoutMs === undefined
        ? await condition(() => usable() || cancelled).then(() => true)
        : await condition(() => usable() || cancelled, timeoutMs);
      waitsFor.delete(nodeId);
      if (cancelled) return { answered: false, reason: 'the run was cancelled' };
      if (!answered) return { answered: false, reason: 'nobody answered in the time this step waits' };
      const value = answers.get(nodeId);
      if (patched(ANSWERS_TAKEN_ONCE)) answers.delete(nodeId);
      return { answered: true, value };
    },
  };

  const remote: NodeImplementation[] = catalogue.list()
    .filter((definition) => definition.runs === 'activity' || definition.runs === 'stream' || definition.runs === 'sandbox')
    .map((definition) => {
      const call = async (request: NodeRequest): Promise<RemoteNodeResult> => {
        const retryable = (definitionFor(catalogue, request.node) ?? definition).idempotent;
        if (definition.runs === 'stream') {
          return cancellable(() => (retryable ? stream : streamOnce).EngineStreamNodeActivity(toRemote(request)));
        }
        const { notices, ...result } = await cancellable(() => (retryable ? engineNodes : engineNodesOnce).EngineNodeActivity(toRemote(request)));
        for (const notice of notices ?? []) {
          bus.emit({ type: 'notice', runId: ticket.runId, at: new Date(Date.now()).toISOString(), level: notice.level, message: notice.message, nodeId: notice.nodeId ?? request.node.id, ...(notice.post ? { post: notice.post } : {}) } as EngineEvent);
        }
        return result as RemoteNodeResult;
      };
      return definition.role === 'step'
        ? stepImplementation(definition.kind, async (request) => (await call(request)) as StepResult)
        : valueImplementation(definition.kind, async (request) => (await call(request)) as ValueResult);
    });

  const inner = createNodeExecutor(catalogue, [
    ...WORKFLOW_IMPLEMENTATIONS,
    ...createOrchestrationNodes(ports),
    ...remote,
  ]);

  const executor: NodeExecutor = {
    async step(request) {
      const result = await inner.step(request);
      rounds = request.run.counters.rounds;
      await flush();
      return result;
    },
    value: (request) => inner.value(request),
  };

  const signal = { get aborted() { return cancelled; }, reason: 'the run was cancelled' } as AbortSignal;

  return CancellationScope.nonCancellable(async () => {
    if (ticket.depth === 0 && !input.continued && patched(CONCLUSIONS)) {
      await conclude({
        kind: 'run-started',
        ownerId: ticket.ownerId,
        runId: ticket.runId,
        agentSlug: ticket.agentSlug,
        depth: ticket.depth,
        ...(conversationId ? { conversationId } : {}),
      });
    }
    const resolvedLimits = continued?.limits ?? await EngineRunLimitsActivity({
      ownerId: ticket.ownerId,
      agentSlug: ticket.agentSlug,
      procedure,
      ...(ticket.modelId ? { modelId: ticket.modelId } : {}),
    });
    const { modelKey, modelLabel, limits } = resolvedLimits;
    const continueAfter = input.continueAfterEvents ?? CONTINUE_AFTER_EVENTS;

    const pauseWhen = (): boolean => {
      if (cancelled) return false;
      const info = workflowInfo();
      return info.continueAsNewSuggested || info.historyLength >= continueAfter;
    };

    const result = await runProcedure({
      procedure,
      catalogue,
      groups: platformGroups(),
      executor,
      identity: {
        runId: ticket.runId,
        ...(ticket.parentRunId ? { parentRunId: ticket.parentRunId } : {}),
        ...(ticket.parentCallId ? { parentCallId: ticket.parentCallId } : {}),
        depth: ticket.depth,
        agentId: ticket.agentSlug,
        loopId: procedure.id,
        loopVersion: procedure.version,
        trigger: ticket.trigger,
      },
      launch: { ...launchFor(ticket, input.projectId), ...(input.environment ? { environment: input.environment } : {}) },
      inputs: input.inputs,
      budget: limits,
      bus,
      signal,
      ...(continued ? { resume: continued.checkpoint } : {}),
      pauseWhen,
      now: () => Date.now(),
      onTrace: (trace) => {
        traces.push(trace);
        bus.emit({ type: 'node.traced', runId: ticket.runId, at: new Date(Date.now()).toISOString(), nodeId: trace.node, trace: tracedSummary(trace as unknown as Record<string, unknown>) } as EngineEvent);
      },
    });

    await flush();

    if (result.paused) {
      const next: RunContinuation = {
        checkpoint: result.paused,
        limits: resolvedLimits,
        children,
        ...(produced.length ? { produced } : {}),
        ...(steps.length ? { steps } : {}),
        approvedForRun,
        approvals: [...approvals],
        answers: [...answers],
        segment: (continued?.segment ?? 0) + 1,
      };
      return continueAsNew<typeof AgentRunWorkflow>({ ...input, continued: next });
    }

    await EngineSettleClaimsActivity({
      ownerId: ticket.ownerId,
      runId: ticket.runId,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
    });

    const ask = typeof input.inputs.message === 'string' ? input.inputs.message : JSON.stringify(input.inputs);
    await EngineRecordEffortActivity({
      runId: ticket.runId,
      ownerId: ticket.ownerId,
      ...(ticket.parentRunId ? { parentRunId: ticket.parentRunId } : {}),
      agentSlug: ticket.agentSlug,
      procedureId: procedure.id,
      procedureVersion: procedure.version,
      modelKey,
      modelLabel,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      rounds: result.counters.rounds,
      toolCalls: result.counters.toolCalls,
      totalTokens: result.counters.totalTokens,
      childRuns: result.counters.childRuns,
      longestReply: result.counters.longestReply,
      cappedAt: result.counters.cappedAt,
      steps: result.steps,
      wallClockMs: result.counters.elapsedMs,
      ask: ask.slice(0, ASK_CHARS),
      limits,
      finishedAt: new Date(Date.now()).toISOString(),
    });

    if (patched(CONCLUSIONS)) {
      await conclude({
        kind: 'run-ended',
        ownerId: ticket.ownerId,
        runId: ticket.runId,
        agentSlug: ticket.agentSlug,
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
        ask: ask.slice(0, ASK_CHARS),
        depth: ticket.depth,
        ...(conversationId ? { conversationId } : {}),
        ...(leafId ? { leafId } : {}),
      });
    }

    const finished = result.finishedBy ? result.outputs[result.finishedBy]?.result : undefined;
    const outputs = finished === undefined ? {} : (isRecord(finished) ? finished : { result: finished });

    return {
      runId: result.runId,
      agentId: ticket.agentSlug,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      outputs,
      ...(produced.length ? { artifacts: produced } : {}),
      ...(steps.length ? { steps } : {}),
    };
  });
}
