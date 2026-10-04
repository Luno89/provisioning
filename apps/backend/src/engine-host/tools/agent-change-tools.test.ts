import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolHandlerContext } from '@koala/engine-core';
import type { AgentChange } from '../../lib/agent-changes.js';
import { createAgentChangeTools } from './agent-change-tools.js';
import { AGENT_CHANGE_TOOLS } from './agent-change-tools-catalogue.js';

let saved: AgentChange[];
let ids: number;

const tools = () => createAgentChangeTools({
  agent: async (_ownerId, slug) => (slug === 'koala' ? { prompt: 'You help the person.', procedure: 'interactive-chat' } : undefined),
  procedures: async () => ['interactive-chat', 'research'],
  changes: { list: async () => saved, save: async (change) => { saved.push(change); } },
  now: () => 'now',
  newId: () => `c-${(ids += 1)}`,
});

const call = (name: string, parsed: Record<string, unknown>) =>
  tools()[name]!({ name, parsed, driver: undefined, caller: { ownerId: 'u1', runId: 'memory-run-1', agentSlug: 'memory-keeper' } } as ToolHandlerContext);

beforeEach(() => { saved = []; ids = 0; });

describe('propose_prompt_change', () => {
  it('records the new prompt next to the one it replaces, waiting for the bench', async () => {
    const out = await call('propose_prompt_change', { agent: 'koala', prompt: 'You help the person. Check before answering.', why: 'it guessed in r-9' });
    expect(out.ok).toBe(true);
    expect(saved[0]).toMatchObject({ kind: 'prompt', agent: 'koala', currentPrompt: 'You help the person.', prompt: 'You help the person. Check before answering.', status: 'proposed', proposedBy: 'memory-run-1' });
  });

  it('proposes nothing that is unchanged, for an agent that does not exist, or while another change for it waits', async () => {
    expect((await call('propose_prompt_change', { agent: 'koala', prompt: 'You help the person.', why: 'w' })).ok).toBe(false);
    expect((await call('propose_prompt_change', { agent: 'nobody', prompt: 'x', why: 'w' })).ok).toBe(false);
    await call('propose_prompt_change', { agent: 'koala', prompt: 'changed', why: 'w' });
    expect((await call('propose_prompt_change', { agent: 'koala', prompt: 'changed again', why: 'w' })).content).toBe('a prompt change for koala is already waiting; nothing was proposed');
    expect(saved).toHaveLength(1);
  });
});

describe('request_procedure_change', () => {
  it('files a plain-words request against the agent\'s own procedure unless another is named', async () => {
    await call('request_procedure_change', { agent: 'koala', request: 'stop after one tool round', why: 'w' });
    await call('request_procedure_change', { agent: 'koala', procedure: 'research', request: 'fail on an empty reply', why: 'w' });
    expect(saved.map((change) => change.kind === 'procedure' && change.procedure)).toEqual(['interactive-chat', 'research']);
    expect((await call('request_procedure_change', { agent: 'koala', procedure: 'ghost', request: 'x', why: 'w' })).content).toBe('there is no procedure called "ghost"');
  });

  it('are both proposals, so neither changes anything on its own', () => {
    expect(AGENT_CHANGE_TOOLS.map((tool) => [tool.name, tool.effect])).toEqual([['propose_prompt_change', 'propose'], ['request_procedure_change', 'propose']]);
  });
});
