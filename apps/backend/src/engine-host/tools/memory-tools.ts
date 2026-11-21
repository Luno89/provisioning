import { v4 as uuidv4 } from 'uuid';
import { refuse, textArgument, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import { createMemoryWriter, currentMemory, recalledInOrder, sameMemoryText, type MemoryWriterStore } from '../../memory/index.js';
import type { MemoryItem, MemorySources } from '../drivers/memory-store.js';
import { unqualify } from '../../engine/lib/mcp-tools.js';
import { noteSubject } from '../../engine/lib/tool-notes.js';

export interface KnownTools {
  tools: readonly string[];
  servers: readonly { name: string; tools: readonly string[] }[];
}

export type MemoryToolStore = MemoryWriterStore & { search(ownerId: string, query: string, limit: number): Promise<string[]> };

const text = textArgument;

const describe = (memory: MemoryItem): string =>
  `- id ${memory.id} [${memory.category}, ${memory.scope ?? 'global'}${memory.model ? `, only for ${memory.model}` : ''}] ${memory.title}: ${memory.text}`;

export function searchAnswer(memories: readonly MemoryItem[], rankedIds: readonly string[], query: string): { found: number; text: string } {
  const found = recalledInOrder(memories, rankedIds).filter(currentMemory);
  if (found.length === 0) return { found: 0, text: `Nothing remembered matches "${query}".` };
  return { found: found.length, text: found.map(describe).join('\n') };
}

function noteTarget(parsed: Record<string, unknown>, known: KnownTools): { tool?: string; server?: string } | { refused: string } {
  const tool = text(parsed, 'tool');
  const server = text(parsed, 'server');
  if (tool && server) return { refused: 'give tool or server, not both; for one tool of a server, name it as it is offered, <server>__<tool>' };
  if (server) {
    return known.servers.some((entry) => entry.name === server) ? { server } : { refused: `there is no MCP server called "${server}"` };
  }
  if (!tool) return { refused: 'name the tool the note is about, as it is offered, or the server' };
  if (known.tools.includes(tool)) return { tool };
  const served = unqualify(tool);
  const host = served ? known.servers.find((entry) => entry.name === served.server) : undefined;
  if (served && host?.tools.includes(served.tool)) return { server: host.name, tool: served.tool };
  return { refused: `there is no tool called "${tool}"; name it exactly as it is offered` };
}

export type MemorySourcesFound = MemorySources | undefined;

export function createMemoryTools(options: { store: MemoryToolStore; agents?: ((ownerId: string) => Promise<string[]>) | undefined; models?: ((ownerId: string) => Promise<string[]>) | undefined; tools?: ((ownerId: string) => Promise<KnownTools>) | undefined; sourcesOf?: ((runId: string) => Promise<MemorySources | undefined>) | undefined; now?: () => string; newId?: () => string }): Record<string, ToolHandler> {
  const provenanceOf = async (runId: string | undefined): Promise<MemoryItem['provenance'] | undefined> => {
    if (!runId) return undefined;
    const sources = await options.sourcesOf?.(runId);
    return { experimentId: runId, ...(sources ? { sources } : {}) };
  };
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? uuidv4;
  const { store } = options;
  const writer = createMemoryWriter({ store, now, newId });

  const onTrial = async (runId: string | undefined, fields: Pick<MemoryItem, 'ownerId' | 'category' | 'title' | 'text'> & Partial<Pick<MemoryItem, 'agent' | 'model' | 'tool' | 'server' | 'why'>>): Promise<MemoryItem> => {
    const at = now();
    const provenance = await provenanceOf(runId);
    const item: MemoryItem = { id: newId(), ...fields, scope: 'global', recommendedScope: 'global', status: 'trial', source: 'agent_tool', ...(provenance ? { provenance } : {}), createdAt: at, updatedAt: at };
    await writer.keep([item]);
    return item;
  };

  const modelOf = async (ownerId: string, parsed: Record<string, unknown>): Promise<{ model?: string } | { refused: string }> => {
    const model = text(parsed, 'model');
    if (!model) return {};
    const known = options.models ? await options.models(ownerId) : [];
    if (!known.includes(model)) {
      return { refused: `"${model}" is not one of the person's models; name the model exactly as read_run shows it, or leave model out` };
    }
    return { model };
  };

  return {
    async search_memories({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose memories to search');
      const query = text(parsed, 'query');
      if (!query) return refuse('give a query: what to look for');
      const mine = (await store.list(caller.ownerId)).filter((memory) => memory.ownerId === caller.ownerId);
      let ranked: string[];
      try {
        ranked = await store.search(caller.ownerId, query, mine.length);
      } catch (err) {
        return refuse(`memories cannot be searched just now: ${(err as Error).message}`);
      }
      const answer = searchAnswer(mine, ranked, query);
      return { ok: true, digest: answer.found ? `${answer.found} memories match` : 'nothing remembered matches', content: answer.text };
    },

    async save_memory({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to remember anything for');
      const body = text(parsed, 'text');
      if (!body) return refuse('give the text to remember');
      const forModel = await modelOf(ownerId, parsed);
      if ('refused' in forModel) return refuse(forModel.refused);
      const provenance = await provenanceOf(caller.runId);
      const outcome = await writer.save({
        ownerId,
        projectId: caller.projectId,
        text: body,
        title: text(parsed, 'title'),
        category: text(parsed, 'category'),
        scope: text(parsed, 'scope'),
        model: forModel.model,
        replaces: text(parsed, 'replaces'),
        provenance,
      });
      if ('refused' in outcome) return refuse(outcome.refused);
      if ('known' in outcome) return { ok: true, digest: `already known: ${outcome.known.title}`, content: `That is already remembered as ${outcome.known.id}; nothing new was stored.` };
      const { saved, replaced, unindexed } = outcome;
      const later = unindexed ? ` ${unindexed}, so it is found once the index answers again.` : '';
      return {
        ok: true,
        digest: `${replaced ? `replaced ${replaced.title} with ${saved.title}` : `remembered ${saved.title}`}${forModel.model ? ` for ${forModel.model}` : ''}`,
        content: `${replaced ? `Saved as ${saved.id}, replacing ${replaced.id}.` : `Saved as ${saved.id}.`}${later}`,
      };
    },

    async propose_practice({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to propose a practice for');
      const agent = text(parsed, 'agent');
      const body = text(parsed, 'text');
      const why = text(parsed, 'why');
      if (!agent || !body || !why) return refuse('give the agent, the practice and what it was learned from');
      if (options.agents && !(await options.agents(ownerId)).includes(agent)) return refuse(`there is no agent called "${agent}"`);
      const forModel = await modelOf(ownerId, parsed);
      if ('refused' in forModel) return refuse(forModel.refused);
      const title = text(parsed, 'title') ?? body.split('\n')[0]!.slice(0, 60);
      const learned = `${body}\n(learned from: ${why})`;
      const known = (await store.list(ownerId)).find((memory) => !memory.invalidAt && memory.category === 'practice' && memory.agent === agent && memory.model === forModel.model && sameMemoryText(memory.text, body));
      if (known) return refuse(`${agent} already has that practice${forModel.model ? ` on ${forModel.model}` : ''} (${known.id}, ${known.status ?? 'active'}); nothing was proposed`);

      const item = await onTrial(caller.runId, { ownerId, category: 'practice', agent, ...(forModel.model ? { model: forModel.model } : {}), title, text: learned });
      const on = forModel.model ? ` on ${forModel.model}` : '';
      return { ok: true, digest: `practice on trial for ${agent}${on}: ${title}`, content: `Proposed ${item.id} for ${agent}${on}; it is on trial until the bench has run ${agent}'s scenarios with it${on}.` };
    },

    async propose_tool_note({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to propose a note for');
      const body = text(parsed, 'text');
      const why = text(parsed, 'why');
      if (!body || !why) return refuse('give the note and what it was learned from');
      const target = noteTarget(parsed, options.tools ? await options.tools(ownerId) : { tools: [], servers: [] });
      if ('refused' in target) return refuse(target.refused);
      const forModel = await modelOf(ownerId, parsed);
      if ('refused' in forModel) return refuse(forModel.refused);
      const about = noteSubject(target);
      const on = forModel.model ? ` on ${forModel.model}` : '';
      const known = (await store.list(ownerId)).find((memory) => !memory.invalidAt && memory.category === 'tool_note' && memory.tool === target.tool && memory.server === target.server && memory.model === forModel.model && sameMemoryText(memory.text, body));
      if (known) return refuse(`${about} already has that note${on} (${known.id}, ${known.status ?? 'active'}); nothing was proposed`);

      const item = await onTrial(caller.runId, {
        ownerId,
        category: 'tool_note',
        ...(target.tool ? { tool: target.tool } : {}),
        ...(target.server ? { server: target.server } : {}),
        ...(forModel.model ? { model: forModel.model } : {}),
        title: text(parsed, 'title') ?? body.split('\n')[0]!.slice(0, 60),
        text: body,
        why,
      });
      return { ok: true, digest: `note on trial for ${about}${on}: ${item.title}`, content: `Proposed ${item.id} for ${about}${on}; it is on trial until the bench has run the checks that use it${on}.` };
    },

    async forget_memory({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner whose memories to change');
      const id = text(parsed, 'id');
      const why = text(parsed, 'why');
      if (!id || !why) return refuse('give the id to retire and why it is no longer true');
      const outcome = await writer.forget(ownerId, id, why);
      if ('refused' in outcome) return refuse(outcome.refused);
      return { ok: true, digest: `retired ${outcome.retired.title}`, content: `Retired ${id}.` };
    },
  };
}
