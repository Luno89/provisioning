import { v4 as uuidv4 } from 'uuid';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { AgentChange } from '../../lib/agent-changes.js';

export interface AgentChangeAccess {
  agent(ownerId: string, slug: string): Promise<{ prompt: string; procedure: string } | undefined>;
  procedures(ownerId: string): Promise<string[]>;
  changes: {
    list(ownerId: string): Promise<AgentChange[]>;
    save(change: AgentChange): Promise<void>;
  };
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

const text = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const WAITING = new Set(['proposed', 'comparing', 'ready']);

export function createAgentChangeTools(access: AgentChangeAccess): Record<string, ToolHandler> {
  const now = access.now ?? (() => new Date().toISOString());
  const newId = access.newId ?? uuidv4;
  return {
    async propose_prompt_change({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to propose a change to');
      const slug = text(parsed, 'agent');
      const prompt = text(parsed, 'prompt');
      const why = text(parsed, 'why');
      if (!slug || !prompt || !why) return refuse('give the agent, the whole new prompt and why');
      const agent = await access.agent(ownerId, slug);
      if (!agent) return refuse(`there is no agent called "${slug}"`);
      if (agent.prompt.trim() === prompt) return refuse('that is the prompt it already has; nothing was proposed');
      if ((await access.changes.list(ownerId)).some((change) => change.kind === 'prompt' && change.agent === slug && WAITING.has(change.status))) {
        return refuse(`a prompt change for ${slug} is already waiting; nothing was proposed`);
      }
      const change: AgentChange = {
        id: newId(), ownerId, kind: 'prompt', agent: slug, prompt, currentPrompt: agent.prompt, why, status: 'proposed',
        ...(caller.runId ? { proposedBy: caller.runId } : {}), createdAt: now(),
      };
      await access.changes.save(change);
      return { ok: true, digest: `proposed a prompt change for ${slug}`, content: `Proposed ${change.id}; the bench compares ${slug}'s scenarios with it, then it waits for the person.` };
    },

    async request_procedure_change({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to ask');
      const slug = text(parsed, 'agent');
      const request = text(parsed, 'request');
      const why = text(parsed, 'why');
      if (!slug || !request || !why) return refuse('give the agent, what should change and why');
      const agent = await access.agent(ownerId, slug);
      if (!agent) return refuse(`there is no agent called "${slug}"`);
      const procedure = text(parsed, 'procedure') ?? agent.procedure;
      if (!(await access.procedures(ownerId)).includes(procedure)) return refuse(`there is no procedure called "${procedure}"`);
      const change: AgentChange = {
        id: newId(), ownerId, kind: 'procedure', agent: slug, procedure, request, why, status: 'proposed',
        ...(caller.runId ? { proposedBy: caller.runId } : {}), createdAt: now(),
      };
      await access.changes.save(change);
      return { ok: true, digest: `asked for a change to ${procedure}`, content: `Filed ${change.id}; it waits for the person to hand it to the agent builder.` };
    },
  };
}
