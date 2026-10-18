import type { AgentDefinition } from '../../agent/agent.js';
import { stepImplementation, type NodeImplementation } from '../implementation.js';
import { fillTemplate } from '../template.js';
import type { NodeRequest, RunContext } from '../interpreter.js';
import type {
  Artifact,
  ChildSteps,
  ChildOutcomeValue,
  EnvironmentValue,
  ExternalAgentOutcome,
  ModelReply,
  ToolCallRequest,
  ToolResult,
  ToolSet,
} from '../values.js';
import { numberOf, textOf } from './read.js';
import { effectiveMachineChoice, machineChoice, machineChoiceId, machineSessionKey, type MachineChoice } from '../machine-choice.js';
import { DECIDE_INSTRUCTIONS, readDecision } from './model.js';
import { RUN_IN_WORKSPACE_DESCRIPTION, RUN_IN_WORKSPACE_NAME } from '../../runtime/context.js';

export interface ToolRunRequest {
  nodeId: string;
  call: ToolCallRequest;
  persona: AgentDefinition;
  environment?: EnvironmentValue | undefined;
  run: RunContext;
}

export interface ToolRunOutcome {
  ok: boolean;
  digest: string;
  content?: string | undefined;
  /** The call ran, but the peer refused it — a site that blocks fetches replying 401/403, for example. */
  declined?: boolean | undefined;
  artifacts?: Artifact[] | undefined;
  child?: ChildSteps | undefined;
}

export interface ChildRunRequest {
  nodeId: string;
  callId?: string | undefined;
  agent: string;
  inputs: Record<string, unknown>;
  environment?: EnvironmentValue | undefined;
  run: RunContext;
}

export interface ApprovalRequest {
  nodeId: string;
  call: ToolCallRequest;
  environment?: EnvironmentValue | undefined;
  run: RunContext;
}

export interface QuestionRequest {
  nodeId: string;
  prompt: string;
  choices?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  run: RunContext;
}

export interface QuestionAnswer {
  answered: boolean;
  value?: unknown;
  reason?: string | undefined;
}

export interface ExternalServedToolValue {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ExternalToolCallValue {
  callId: string;
  name: string;
  arguments: string;
}

export type WorkspaceEnvironment = Extract<EnvironmentValue, { kind: 'sandbox' }>;

export interface ExternalAgentRequest {
  nodeId: string;
  agent: string;
  brief: string;
  context?: string | undefined;
  mode?: string | undefined;
  model?: string | undefined;
  resume?: string | undefined;
  tools?: ExternalServedToolValue[] | undefined;
  callTool?: ((call: ExternalToolCallValue) => Promise<{ ok: boolean; content: string }>) | undefined;
  environment: Extract<EnvironmentValue, { kind: 'machine' }>;
  workspace?: WorkspaceEnvironment | undefined;
  run: RunContext;
}

export const RUN_IN_WORKSPACE = RUN_IN_WORKSPACE_NAME;

export const RUN_IN_WORKSPACE_TOOL: ExternalServedToolValue = {
  name: RUN_IN_WORKSPACE,
  description: RUN_IN_WORKSPACE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command, run from the same folder of the project as yours.' },
      timeoutSeconds: { type: 'integer', description: 'Stop it after this many seconds. Leave it out to let it run until it finishes.' },
    },
    required: ['command'],
  },
};

export function machineOfRun(run: RunContext, persona: AgentDefinition | undefined): MachineChoice | undefined {
  return effectiveMachineChoice(run.launch.modelId, persona?.model?.endpointId);
}

function machineEnvironment(choice: MachineChoice): Extract<EnvironmentValue, { kind: 'machine' }> {
  return { kind: 'machine', deviceId: choice.deviceId, deviceName: 'your machine', egressMode: 'auto' };
}

export interface OrchestrationPorts {
  runTool(request: ToolRunRequest): Promise<ToolRunOutcome>;
  runChild(request: ChildRunRequest): Promise<ChildOutcomeValue>;
  approve(request: ApprovalRequest): Promise<boolean>;
  ask(request: QuestionRequest): Promise<QuestionAnswer>;
  runExternal?(request: ExternalAgentRequest): Promise<ExternalAgentOutcome>;
  handOffsTogether?(): boolean;
  sandboxCallsUnasked?(): boolean;
  readsTogether?(): boolean;
}

export const REFUSED_CALL = 'you did not approve that call, so it did not run';
/** Shown on a saved tool call that never got a result — the run ended before it could run. */
export const NOT_RUN_CALL = 'it did not run — the run ended before it got a result';

const DEFAULT_DIGEST_CHARS = 2000;

const replyOf = (id: string, text: string, finishReason: string): ModelReply => ({ id, content: text, thinking: '', finishReason, toolCalls: [] });

function conversationText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const lines = messages.flatMap((message) => {
    const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) return [];
    return [`${role === 'user' ? 'The person' : 'You'}: ${content.trim()}`];
  });
  return lines.length ? `The conversation so far:\n\n${lines.join('\n\n')}` : undefined;
}

function openingOf(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const asked = messages.filter((message) => (message as { role?: unknown })?.role === 'user');
  if (asked.length !== 1) return undefined;
  const content = (asked[0] as { content?: unknown }).content;
  return typeof content === 'string' && content.trim() ? content.trim() : undefined;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const template = (request: NodeRequest, setting: string): Record<string, unknown> => {
  const written = JSON.parse(textOf(request.node.settings, setting, '{}')) as Record<string, unknown>;
  return fillTemplate(written, {
    values: (request.inputs.values as Record<string, unknown> | undefined) ?? {},
    text: typeof request.inputs.text === 'string' ? request.inputs.text : '',
  }, request.node.id);
};

const sandboxOf = (environment: unknown): EnvironmentValue | undefined => {
  const candidate = environment as EnvironmentValue | undefined;
  return candidate?.kind === 'sandbox' ? candidate : undefined;
};

const childText = (agent: string, child: ChildOutcomeValue): string =>
  child.outcome === 'ok' ? JSON.stringify(child.outputs) : `${agent} did not finish: ${child.reason ?? child.outcome}`;

export function createOrchestrationNodes(ports: OrchestrationPorts): NodeImplementation[] {
  const runOne = async (request: NodeRequest, call: ToolCallRequest, persona: AgentDefinition, environment: EnvironmentValue | undefined) => {
    const { node, run } = request;
    run.emit({ type: 'tool.called', nodeId: node.id, callId: call.id, name: call.name, args: call.arguments } as never);

    let outcome: ToolRunOutcome;
    let delegated = false;

    if ((persona.agents ?? []).includes(call.name)) {
      delegated = true;
      const inputs = parseJson(call.arguments || '{}');
      if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
        const why = `the arguments for "${call.name}" were not a JSON object`;
        outcome = { ok: false, digest: why, content: why };
      } else {
        const handed = sandboxOf(environment) ?? sandboxOf(run.launch.environment);
        const child = await ports.runChild({
          nodeId: node.id,
          callId: call.id,
          agent: call.name,
          inputs: inputs as Record<string, unknown>,
          ...(handed ? { environment: handed } : {}),
          run,
        });
        const text = childText(call.name, child);
        outcome = {
          ok: child.outcome === 'ok',
          digest: text,
          content: text,
          ...(child.artifacts?.length ? { artifacts: child.artifacts } : {}),
          child: { runId: child.runId, agentId: child.agentId, outcome: child.outcome, ...(child.reason ? { reason: child.reason } : {}), steps: child.steps ?? [] },
        };
      }
    } else {
      outcome = await ports.runTool({ nodeId: node.id, call, persona, environment, run });
    }

    run.emit({ type: 'tool.result', nodeId: node.id, callId: call.id, ok: outcome.ok, digest: outcome.digest, ...(outcome.artifacts?.length ? { artifacts: outcome.artifacts } : {}), ...(outcome.child ? { child: outcome.child } : {}) } as never);
    return { outcome, delegated };
  };

  return [
    stepImplementation('approve-tool-calls', async (request) => {
      const { node, inputs, run } = request;
      const reply = inputs.reply as ModelReply;
      const environment = inputs.environment as EnvironmentValue | undefined;
      const ask = textOf(node.settings, 'ask', 'on-a-machine');
      const offered = (inputs.offered as ToolSet | undefined) ?? [];
      const destructive = new Set(offered.filter((tool) => tool.destructive === true).map((tool) => tool.name));
      const inSandbox = environment?.kind === 'sandbox' && ports.sandboxCallsUnasked?.() === true
        ? new Set(offered.filter((tool) => tool.binding === 'environment').map((tool) => tool.name))
        : new Set<string>();
      const needsAsking = (call: ToolCallRequest): boolean => {
        if (ask === 'never') return false;
        if (ask === 'always') return true;
        if (inSandbox.has(call.name)) return false;
        return environment?.kind === 'machine' || destructive.has(call.name);
      };

      if (!reply.toolCalls.some(needsAsking)) {
        return { exit: 'approved', outputs: { approved: reply, refused: [] } };
      }

      const approved: ToolCallRequest[] = [];
      const refused: ToolResult[] = [];
      for (const call of reply.toolCalls) {
        if (!needsAsking(call)) { approved.push(call); continue; }
        run.emit({ type: 'tool.called', nodeId: node.id, callId: call.id, name: call.name, args: call.arguments } as never);
        if (await ports.approve({ nodeId: node.id, call, environment, run })) {
          approved.push(call);
        } else {
          refused.push({ forReply: reply.id, callId: call.id, name: call.name, ok: false, digest: REFUSED_CALL, content: REFUSED_CALL });
          run.emit({ type: 'tool.result', nodeId: node.id, callId: call.id, ok: false, digest: REFUSED_CALL } as never);
        }
      }

      return {
        exit: approved.length > 0 ? 'approved' : 'refused',
        outputs: { approved: { ...reply, toolCalls: approved }, refused },
      };
    }),

    stepImplementation('run-tool-calls', async (request) => {
      const { node, inputs, run } = request;
      const reply = inputs.reply as ModelReply;
      const persona = inputs.persona as AgentDefinition;
      const environment = inputs.environment as EnvironmentValue | undefined;
      const digestChars = numberOf(node.settings, 'digestChars', DEFAULT_DIGEST_CHARS);
      const delegates = new Set(ports.handOffsTogether?.() === false ? [] : persona.agents ?? []);
      const handOffs = new Map(reply.toolCalls
        .filter((call) => delegates.has(call.name))
        .map((call) => [call.id, runOne(request, call, persona, environment)] as const));
      for (const handOff of handOffs.values()) handOff.catch(() => undefined);
      const settled: { call: ToolCallRequest; outcome: ToolRunOutcome }[] = [];

      if (ports.readsTogether?.() === true) {
        const reads = new Set(((inputs.offered as ToolSet | undefined) ?? []).filter((tool) => tool.effect === 'read').map((tool) => tool.name));
        const started = new Map<string, Promise<{ outcome: ToolRunOutcome }>>();
        const before: Promise<unknown>[] = [];
        for (const call of reply.toolCalls) {
          const handOff = handOffs.get(call.id);
          if (handOff) {
            before.push(handOff);
            continue;
          }
          if (run.signal?.aborted) continue;
          if (reads.has(call.name)) {
            const reading = runOne(request, call, persona, environment);
            reading.catch(() => undefined);
            started.set(call.id, reading);
            before.push(reading);
            continue;
          }
          await Promise.allSettled(before);
          if (run.signal?.aborted) continue;
          const changing = runOne(request, call, persona, environment);
          started.set(call.id, changing);
          before.push(changing);
          await changing.catch(() => undefined);
        }
        for (const call of reply.toolCalls) {
          const running = handOffs.get(call.id) ?? started.get(call.id);
          if (running) settled.push({ call, outcome: (await running).outcome });
        }
      } else {
        for (const call of reply.toolCalls) {
          const handOff = handOffs.get(call.id);
          if (handOff) {
            settled.push({ call, outcome: (await handOff).outcome });
            continue;
          }
          if (run.signal?.aborted) continue;
          settled.push({ call, outcome: (await runOne(request, call, persona, environment)).outcome });
        }
      }

      const results: ToolResult[] = settled.map(({ call, outcome }) => ({
        forReply: reply.id,
        callId: call.id,
        name: call.name,
        ok: outcome.ok,
        digest: outcome.digest.slice(0, digestChars),
        content: outcome.content ?? outcome.digest,
        ...(outcome.declined ? { declined: outcome.declined } : {}),
        ...(outcome.artifacts?.length ? { artifacts: outcome.artifacts } : {}),
        ...(outcome.child ? { child: outcome.child } : {}),
      }));

      const childRuns = settled.filter(({ call }) => (persona.agents ?? []).includes(call.name)).length;
      return { exit: 'done', outputs: { results }, usage: { toolCalls: results.length - childRuns, childRuns } };
    }),

    stepImplementation('call-tool', async (request) => {
      const { node, inputs, execution } = request;
      const call: ToolCallRequest = {
        id: `${node.id}#${execution}`,
        name: textOf(node.settings, 'tool'),
        arguments: JSON.stringify(template(request, 'args')),
      };
      const { outcome } = await runOne(request, call, inputs.persona as AgentDefinition, inputs.environment as EnvironmentValue | undefined);
      const text = outcome.content ?? outcome.digest;

      return { exit: outcome.ok ? 'ok' : 'failed', outputs: { result: parseJson(text), text }, usage: { toolCalls: 1 } };
    }),

    stepImplementation('delegate', async (request) => {
      const { node, inputs, run } = request;
      const agent = textOf(node.settings, 'agent');
      const handed = (inputs.environment as EnvironmentValue | undefined) ?? sandboxOf(run.launch.environment);
      const child = await ports.runChild({
        nodeId: node.id,
        agent,
        inputs: template(request, 'inputs'),
        ...(handed ? { environment: handed } : {}),
        run,
      });

      return {
        exit: child.outcome === 'ok' ? 'ok' : 'failed',
        outputs: {
          outputs: child.outputs,
          text: typeof child.outputs.result === 'string' ? child.outputs.result : JSON.stringify(child.outputs),
          ...(child.outcome === 'ok' ? {} : { reason: childText(agent, child) }),
        },
        usage: { childRuns: 1 },
      };
    }),

    stepImplementation('fan-out', async ({ node, inputs, run }) => {
      const agent = textOf(node.settings, 'agent');

      let list: unknown = inputs.items;
      const written = textOf(node.settings, 'items');
      if (written) {
        // A whole reference like '{{values.ready}}' resolves to the raw value, list intact.
        list = fillTemplate({ items: written }, {
          values: (inputs.values as Record<string, unknown> | undefined) ?? {},
          text: typeof inputs.text === 'string' ? inputs.text : '',
        }, node.id).items;
      }

      const items = Array.isArray(list) ? list : [];
      const limit = Math.max(1, numberOf(node.settings, 'maxParallel', 3));
      const children: ChildOutcomeValue[] = [];
      const handed = (inputs.environment as EnvironmentValue | undefined) ?? sandboxOf(run.launch.environment);
      const narrowed = (item: unknown): EnvironmentValue | undefined => {
        const worktree = typeof item === 'object' && item !== null ? (item as { worktree?: unknown }).worktree : undefined;
        return handed?.kind === 'sandbox' && typeof worktree === 'string' && worktree.trim() ? { ...handed, worktree: worktree.trim() } : handed;
      };

      for (let offset = 0; offset < items.length; offset += limit) {
        if (run.signal?.aborted) break;
        const batch = await Promise.all(items.slice(offset, offset + limit).map((item, index) => {
          const environment = narrowed(item);
          const spread = node.settings.itemAsInputs === true && typeof item === 'object' && item !== null && !Array.isArray(item);
          const childInputs = spread ? { ...(item as Record<string, unknown>) } : { item, index: offset + index };
          return ports.runChild({ nodeId: node.id, agent, inputs: childInputs, ...(environment ? { environment } : {}), run });
        }));
        children.push(...batch);
      }

      return { exit: 'done', outputs: { children }, usage: { childRuns: children.length } };
    }),

    stepImplementation('wait-for-person', async ({ node, inputs, run }) => {
      const written = textOf(node.settings, 'prompt');
      const details = typeof inputs.details === 'string' ? inputs.details.trim() : '';
      const prompt = details ? `${written}\n\n${details}` : written;
      const choices = Array.isArray(node.settings.choices) ? node.settings.choices.filter((choice): choice is string => typeof choice === 'string' && choice.length > 0) : [];
      run.emit({ type: 'notice', level: 'info', nodeId: node.id, message: prompt, ...(choices.length ? { choices } : {}) } as never);

      const waitFor = node.settings.timeoutMinutes === undefined ? undefined : numberOf(node.settings, 'timeoutMinutes', 0);
      const answer = await ports.ask({
        nodeId: node.id,
        prompt,
        ...(choices.length ? { choices } : {}),
        ...(waitFor ? { timeoutMs: waitFor * 60_000 } : {}),
        run,
      });

      return answer.answered
        ? { exit: 'answered', outputs: { answer: answer.value } }
        : { exit: 'unanswered', outputs: { reason: answer.reason ?? 'nobody answered in the time this step waits' } };
    }),

    stepImplementation('external-agent', async (request) => {
      const { node, inputs, run } = request;
      const picked = machineChoice(run.launch.modelId);
      const agent = textOf(node.settings, 'agent') || picked?.agent || run.identity.agentId;
      const model = textOf(node.settings, 'model') || (picked?.agent === agent ? picked.model : undefined);
      const persona = inputs.persona as AgentDefinition | undefined;
      const offered = ((inputs.tools as ToolSet | undefined) ?? []).filter((tool) => tool.binding !== 'environment');
      const destructive = new Set(offered.filter((tool) => tool.destructive === true).map((tool) => tool.name));
      const tools = offered.map((tool) => ({
        name: tool.name,
        description: [tool.description, tool.usageGuidance].filter(Boolean).join('\n\n'),
        inputSchema: tool.parameters ?? { type: 'object', properties: {} },
      }));
      const mode = textOf(node.settings, 'mode');
      const given = (inputs.environment as EnvironmentValue | undefined) ?? (run.launch.environment as EnvironmentValue | undefined);
      const workspace = given?.kind === 'sandbox' ? given : undefined;
      const onMachine = workspace ? machineOfRun(run, persona) : undefined;
      const environment = workspace ? (onMachine ? machineEnvironment(onMachine) : undefined) : given;
      if (workspace) tools.push(RUN_IN_WORKSPACE_TOOL);
      const written = typeof inputs.brief === 'string' ? inputs.brief.trim() : '';
      const opening = written ? undefined : openingOf(inputs.conversation);
      const brief = written || opening || '';
      const said = opening ? undefined : conversationText(inputs.conversation);
      const context = [inputs.prompt, inputs.context, inputs.memories, said]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .map((part) => part.trim())
        .join('\n\n');
      const failed = (reason: string) => ({ exit: 'failed', outputs: { text: '', reply: replyOf(node.id, '', 'error'), reason } });
      if (!ports.runExternal) return failed('this host cannot run an external agent');
      if (environment?.kind !== 'machine') return failed(`${agent} works on a person's machine, and ${workspace ? 'no machine was picked for this run' : 'this run has none'}`);
      if (!brief) return failed(`there was no task to hand ${agent}`);

      const key = machineSessionKey({ deviceId: environment.deviceId, agent, ...(model ? { model } : {}) });
      const callTool = async (asked: { callId: string; name: string; arguments: string }): Promise<{ ok: boolean; content: string }> => {
        if (asked.name === RUN_IN_WORKSPACE && workspace && persona) {
          const command: ToolCallRequest = { id: asked.callId, name: 'run_command', arguments: asked.arguments };
          const runsCommands = { ...persona, tools: [...new Set([...(persona.tools ?? []), 'run_command'])] };
          const { outcome } = await runOne(request, command, runsCommands, workspace);
          return { ok: outcome.ok, content: outcome.content ?? outcome.digest };
        }
        const call: ToolCallRequest = { id: asked.callId, name: asked.name, arguments: asked.arguments };
        if (!persona || !offered.some((tool) => tool.name === call.name)) return { ok: false, content: `${call.name} is not one of the tools offered here` };
        if (destructive.has(call.name)) {
          run.emit({ type: 'tool.called', nodeId: node.id, callId: call.id, name: call.name, args: call.arguments } as never);
          if (!(await ports.approve({ nodeId: node.id, call, environment: workspace ?? environment, run }))) {
            run.emit({ type: 'tool.result', nodeId: node.id, callId: call.id, ok: false, digest: REFUSED_CALL } as never);
            return { ok: false, content: REFUSED_CALL };
          }
        }
        const { outcome } = await runOne(request, call, persona, workspace);
        return { ok: outcome.ok, content: outcome.content ?? outcome.digest };
      };
      const sessions = inputs.sessions && typeof inputs.sessions === 'object' ? inputs.sessions as Record<string, unknown> : {};
      const resume = typeof sessions[key] === 'string' && sessions[key] ? sessions[key] as string : undefined;
      const outcome = await ports.runExternal({
        nodeId: node.id,
        agent,
        brief,
        ...(context ? { context } : {}),
        ...(mode ? { mode } : {}),
        ...(model ? { model } : {}),
        ...(resume ? { resume } : {}),
        ...(tools.length ? { tools, callTool } : {}),
        environment,
        ...(workspace ? { workspace } : {}),
        run,
      });
      const calls = outcome.calls ?? [];
      return {
        exit: outcome.outcome,
        outputs: {
          text: outcome.text,
          reply: {
            ...replyOf(node.id, outcome.text, 'stopReason' in outcome ? outcome.stopReason : 'error'),
            thinking: outcome.thinking ?? '',
            toolCalls: calls.map((call) => ({ id: call.callId, name: call.name, arguments: call.args })),
          },
          results: calls.filter((call) => call.ok !== undefined).map((call) => ({
            forReply: node.id, callId: call.callId, name: call.name, ok: call.ok === true, digest: call.digest ?? '', content: call.digest ?? '',
          })),
          ...(outcome.sessionId ? { session: { key, id: outcome.sessionId } } : {}),
          ...('stopReason' in outcome ? { stopReason: outcome.stopReason } : {}),
          ...(outcome.identity ? { identity: { ...outcome.identity, ...(outcome.model ? { model: outcome.model } : {}) } } : {}),
          ...(outcome.model ? { model: outcome.model } : {}),
          ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
          ...('reason' in outcome ? { reason: outcome.reason } : {}),
        },
        usage: { childRuns: 1 },
      };
    }),

    stepImplementation('where-it-runs', ({ inputs, run }) => {
      const choice = machineOfRun(run, inputs.persona as AgentDefinition | undefined);
      return choice ? { exit: 'machine', outputs: { machine: machineChoiceId(choice) } } : { exit: 'model', outputs: {} };
    }),

    stepImplementation('ask-machine-agent', async ({ node, inputs, run }) => {
      const failed = (reason: string) => ({ exit: 'failed', outputs: { decision: 'unsure', why: '', reason } });
      const choice = machineOfRun(run, undefined);
      if (!ports.runExternal) return failed('this host cannot run an external agent');
      if (!choice) return failed('no machine was picked for this run, so there is no agent there to ask');
      const question = textOf(node.settings, 'question');
      const text = typeof inputs.text === 'string' ? inputs.text : JSON.stringify(inputs.text, null, 2);
      const outcome = await ports.runExternal({
        nodeId: node.id,
        agent: choice.agent,
        brief: `Question: ${question}\n\nText:\n${text}`,
        context: `${DECIDE_INSTRUCTIONS} Change nothing and run nothing: answer from the text alone.`,
        ...(choice.model ? { model: choice.model } : {}),
        environment: machineEnvironment(choice),
        run,
      });
      if (outcome.outcome === 'failed') return failed(outcome.reason);
      const decision = readDecision(outcome.text);
      return { exit: decision, outputs: { decision, why: outcome.text.trim() }, usage: { childRuns: 1 } };
    }),
  ];
}
