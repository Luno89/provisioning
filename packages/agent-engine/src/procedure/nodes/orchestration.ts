import type { AgentDefinition } from '../../agent/agent.js';
import { stepImplementation, type NodeImplementation } from '../implementation.js';
import { fillTemplate } from '../template.js';
import type { NodeRequest, RunContext } from '../interpreter.js';
import type {
  ChildOutcomeValue,
  EnvironmentValue,
  ModelReply,
  ToolCallRequest,
  ToolResult,
} from '../values.js';
import { numberOf, textOf } from './read.js';

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
}

export interface ChildRunRequest {
  nodeId: string;
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
  timeoutMs: number;
  run: RunContext;
}

export interface QuestionAnswer {
  answered: boolean;
  value?: unknown;
  reason?: string | undefined;
}

export interface OrchestrationPorts {
  runTool(request: ToolRunRequest): Promise<ToolRunOutcome>;
  runChild(request: ChildRunRequest): Promise<ChildOutcomeValue>;
  approve(request: ApprovalRequest): Promise<boolean>;
  ask(request: QuestionRequest): Promise<QuestionAnswer>;
}

export const REFUSED_CALL = 'you did not approve that call, so it did not run';

const DEFAULT_DIGEST_CHARS = 2000;

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
        const child = await ports.runChild({ nodeId: node.id, agent: call.name, inputs: inputs as Record<string, unknown>, run });
        const text = childText(call.name, child);
        outcome = { ok: child.outcome === 'ok', digest: text, content: text };
      }
    } else {
      outcome = await ports.runTool({ nodeId: node.id, call, persona, environment, run });
    }

    run.emit({ type: 'tool.result', nodeId: node.id, callId: call.id, ok: outcome.ok, digest: outcome.digest } as never);
    return { outcome, delegated };
  };

  return [
    stepImplementation('approve-tool-calls', async (request) => {
      const { node, inputs, run } = request;
      const reply = inputs.reply as ModelReply;
      const environment = inputs.environment as EnvironmentValue | undefined;
      const ask = textOf(node.settings, 'ask', 'on-a-machine');
      const needsAsking = ask === 'always' || (ask === 'on-a-machine' && environment?.kind === 'machine');

      if (!needsAsking || reply.toolCalls.length === 0) {
        return { exit: 'approved', outputs: { approved: reply, refused: [] } };
      }

      const approved: ToolCallRequest[] = [];
      const refused: ToolResult[] = [];
      for (const call of reply.toolCalls) {
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
      const results: ToolResult[] = [];
      let childRuns = 0;

      for (const call of reply.toolCalls) {
        if (run.signal?.aborted) break;
        const { outcome, delegated } = await runOne(request, call, persona, environment);
        if (delegated) childRuns += 1;
        results.push({
          forReply: reply.id,
          callId: call.id,
          name: call.name,
          ok: outcome.ok,
          digest: outcome.digest.slice(0, digestChars),
          content: outcome.content ?? outcome.digest,
        });
      }

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
      const handed = inputs.environment as EnvironmentValue | undefined;
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
      const items = Array.isArray(inputs.items) ? inputs.items : [];
      const limit = Math.max(1, numberOf(node.settings, 'maxParallel', 3));
      const children: ChildOutcomeValue[] = [];

      for (let offset = 0; offset < items.length; offset += limit) {
        if (run.signal?.aborted) break;
        const batch = await Promise.all(items.slice(offset, offset + limit).map((item, index) =>
          ports.runChild({ nodeId: node.id, agent, inputs: { item, index: offset + index }, run })));
        children.push(...batch);
      }

      return { exit: 'done', outputs: { children }, usage: { childRuns: children.length } };
    }),

    stepImplementation('wait-for-person', async ({ node, inputs, run }) => {
      const written = textOf(node.settings, 'prompt');
      const details = typeof inputs.details === 'string' ? inputs.details.trim() : '';
      const prompt = details ? `${written}\n\n${details}` : written;
      run.emit({ type: 'notice', level: 'info', nodeId: node.id, message: prompt } as never);

      const answer = await ports.ask({
        nodeId: node.id,
        prompt,
        timeoutMs: numberOf(node.settings, 'timeoutMinutes', 10_080) * 60_000,
        run,
      });

      return answer.answered
        ? { exit: 'answered', outputs: { answer: answer.value } }
        : { exit: 'unanswered', outputs: { reason: answer.reason ?? 'nobody answered in time' } };
    }),
  ];
}
