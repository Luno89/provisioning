import type { ExternalAgentAsk, ExternalAgentTool, ExternalAgentWireEvent } from '@koala/engine-core';

export type ExternalRunEvent =
  | { type: 'content' | 'thinking'; nodeId: string; delta: string }
  | { type: 'tool.called'; nodeId: string; callId: string; name: string; args: string }
  | { type: 'tool.result'; nodeId: string; callId: string; ok: boolean; digest: string }
  | { type: 'notice'; level: 'info' | 'warn'; nodeId: string; message: string };

export interface ExternalToolSeen {
  called: Set<string>;
  settled: Set<string>;
}

export const externalCallId = (callId: string): string => `ext-${callId}`;

export const externalToolName = (agent: string, tool: Pick<ExternalAgentTool, 'kind'>): string => `${agent}.${tool.kind}`;

const describeInput = (tool: ExternalAgentTool): string => {
  if (tool.input === undefined || tool.input === null) return tool.title;
  const input = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input);
  return input === tool.title ? tool.title : `${tool.title} ${input}`;
};

export function externalRunEvents(agent: string, nodeId: string, events: readonly ExternalAgentWireEvent[], seen: ExternalToolSeen): { events: ExternalRunEvent[]; text: string } {
  const out: ExternalRunEvent[] = [];
  let text = '';
  for (const event of events) {
    if (event.type === 'text' || event.type === 'thinking') {
      const type = event.type === 'text' ? 'content' : 'thinking';
      if (event.type === 'text') text += event.delta;
      const last = out.at(-1);
      if (last && last.type === type) last.delta += event.delta;
      else out.push({ type, nodeId, delta: event.delta });
    } else if (event.type === 'tool') {
      const { tool } = event;
      const callId = externalCallId(tool.callId);
      if (!seen.called.has(callId)) {
        seen.called.add(callId);
        out.push({ type: 'tool.called', nodeId, callId, name: externalToolName(agent, tool), args: describeInput(tool) });
      }
      if ((tool.status === 'completed' || tool.status === 'failed') && !seen.settled.has(callId)) {
        seen.settled.add(callId);
        out.push({ type: 'tool.result', nodeId, callId, ok: tool.status === 'completed', digest: tool.output ?? (tool.status === 'completed' ? tool.title : `${tool.title} failed`) });
      }
    } else if (event.type === 'stray') {
      out.push({ type: 'notice', level: 'warn', nodeId, message: `${agent} ran \`${event.title}\` in ${event.workingDir}, outside the run's folder ${event.folder}` });
    } else if (event.type === 'plan') {
      out.push({ type: 'notice', level: 'info', nodeId, message: `${agent}'s plan:\n${event.entries.map((entry) => `- [${entry.status}] ${entry.content}`).join('\n')}` });
    }
  }
  return { events: out, text };
}

export function permissionChoice(ask: ExternalAgentAsk, allowed: boolean): string | undefined {
  const wanted = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const option = ask.options.find((candidate) => candidate.kind === kind);
    if (option) return option.optionId;
  }
  return undefined;
}
