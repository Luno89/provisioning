import { v4 as uuidv4 } from 'uuid';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import { unreachableMemory, type MemoryItem } from '../drivers/memory-store.js';
import { unqualify } from '../../engine/lib/mcp-tools.js';
import { noteSubject } from '../../engine/lib/tool-notes.js';

export interface KnownTools {
  tools: readonly string[];
  servers: readonly { name: string; tools: readonly string[] }[];
}

export interface MemoryToolStore {
  list(ownerId: string): Promise<MemoryItem[]>;
  save(item: MemoryItem): Promise<void>;
}

const CATEGORIES = new Set<MemoryItem['category']>(['lessons_learned', 'environment_facts', 'prompt_guidance']);

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

const text = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const words = (value: string): string[] => value.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? [];

const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

const current = (memory: MemoryItem): boolean => !memory.invalidAt && memory.status !== 'pending_review';

const describe = (memory: MemoryItem): string =>
  `- id ${memory.id} [${memory.category}, ${memory.scope ?? 'global'}${memory.model ? `, only for ${memory.model}` : ''}] ${memory.title}: ${memory.text}`;

export function matchMemories(memories: readonly MemoryItem[], query: string): MemoryItem[] {
  const wanted = new Set(words(query));
  return memories
    .filter(current)
    .map((memory) => ({ memory, score: words(`${memory.title} ${memory.text}`).filter((word) => wanted.has(word)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
    .map((entry) => entry.memory);
}

export function searchAnswer(memories: readonly MemoryItem[], query: string): { found: number; text: string } {
  const found = matchMemories(memories, query);
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

export function createMemoryTools(options: { store: MemoryToolStore; agents?: ((ownerId: string) => Promise<string[]>) | undefined; models?: ((ownerId: string) => Promise<string[]>) | undefined; tools?: ((ownerId: string) => Promise<KnownTools>) | undefined; now?: () => string; newId?: () => string }): Record<string, ToolHandler> {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? uuidv4;
  const { store } = options;

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
      if (!query) return refuse('give a query: words to look for');
      const answer = searchAnswer(await store.list(caller.ownerId), query);
      return { ok: true, digest: answer.found ? `${answer.found} memories match` : 'nothing remembered matches', content: answer.text };
    },

    async save_memory({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to remember anything for');
      const body = text(parsed, 'text');
      if (!body) return refuse('give the text to remember');
      const title = text(parsed, 'title') ?? body.split('\n')[0]!.slice(0, 60);
      const asked = text(parsed, 'category') as MemoryItem['category'] | undefined;
      const category = asked && CATEGORIES.has(asked) ? asked : 'lessons_learned';
      const scope = text(parsed, 'scope') === 'global' || (!caller.projectId && text(parsed, 'scope') !== 'project') ? 'global' : 'project';
      const forModel = await modelOf(ownerId, parsed);
      if ('refused' in forModel) return refuse(forModel.refused);
      const mine = (await store.list(ownerId)).filter(current);

      const replaces = text(parsed, 'replaces');
      const old = replaces ? mine.find((memory) => memory.id === replaces) : undefined;
      if (replaces && !old) return refuse(`there is no current memory ${replaces} to replace; nothing was saved`);

      const known = mine.find((memory) => memory.id !== replaces && memory.model === forModel.model && same(memory.title, title) && same(memory.text, body));
      if (known) return { ok: true, digest: `already known: ${known.title}`, content: `That is already remembered as ${known.id}; nothing new was stored.` };

      const at = now();
      const item: MemoryItem = {
        id: newId(),
        ownerId,
        ...(scope === 'project' && caller.projectId ? { projectId: caller.projectId } : {}),
        category,
        ...(forModel.model ? { model: forModel.model } : {}),
        scope,
        recommendedScope: scope,
        status: 'active',
        title,
        text: body,
        source: 'agent_tool',
        ...(caller.runId ? { provenance: { experimentId: caller.runId } } : {}),
        createdAt: at,
        updatedAt: at,
      };
      const unreachable = unreachableMemory(item);
      if (unreachable) return refuse(unreachable);

      await store.save(item);
      if (old) await store.save({ ...old, invalidAt: at, supersededBy: item.id, updatedAt: at });
      return {
        ok: true,
        digest: `${old ? `replaced ${old.title} with ${title}` : `remembered ${title}`}${forModel.model ? ` for ${forModel.model}` : ''}`,
        content: old ? `Saved as ${item.id}, replacing ${old.id}.` : `Saved as ${item.id}.`,
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
      const known = (await store.list(ownerId)).find((memory) => !memory.invalidAt && memory.category === 'practice' && memory.agent === agent && memory.model === forModel.model && same(memory.text, body));
      if (known) return refuse(`${agent} already has that practice${forModel.model ? ` on ${forModel.model}` : ''} (${known.id}, ${known.status ?? 'active'}); nothing was proposed`);

      const at = now();
      const item: MemoryItem = {
        id: newId(),
        ownerId,
        category: 'practice',
        agent,
        ...(forModel.model ? { model: forModel.model } : {}),
        scope: 'global',
        recommendedScope: 'global',
        status: 'trial',
        title,
        text: learned,
        source: 'agent_tool',
        ...(caller.runId ? { provenance: { experimentId: caller.runId } } : {}),
        createdAt: at,
        updatedAt: at,
      };
      await store.save(item);
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
      const known = (await store.list(ownerId)).find((memory) => !memory.invalidAt && memory.category === 'tool_note' && memory.tool === target.tool && memory.server === target.server && memory.model === forModel.model && same(memory.text, body));
      if (known) return refuse(`${about} already has that note${on} (${known.id}, ${known.status ?? 'active'}); nothing was proposed`);

      const at = now();
      const item: MemoryItem = {
        id: newId(),
        ownerId,
        category: 'tool_note',
        ...(target.tool ? { tool: target.tool } : {}),
        ...(target.server ? { server: target.server } : {}),
        ...(forModel.model ? { model: forModel.model } : {}),
        scope: 'global',
        recommendedScope: 'global',
        status: 'trial',
        title: text(parsed, 'title') ?? body.split('\n')[0]!.slice(0, 60),
        text: body,
        why,
        source: 'agent_tool',
        ...(caller.runId ? { provenance: { experimentId: caller.runId } } : {}),
        createdAt: at,
        updatedAt: at,
      };
      await store.save(item);
      return { ok: true, digest: `note on trial for ${about}${on}: ${item.title}`, content: `Proposed ${item.id} for ${about}${on}; it is on trial until the bench has run the checks that use it${on}.` };
    },

    async forget_memory({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner whose memories to change');
      const id = text(parsed, 'id');
      const why = text(parsed, 'why');
      if (!id || !why) return refuse('give the id to retire and why it is no longer true');
      const target = (await store.list(ownerId)).filter(current).find((memory) => memory.id === id);
      if (!target) return refuse(`there is no current memory ${id}`);
      const at = now();
      await store.save({ ...target, invalidAt: at, updatedAt: at, text: `${target.text}\n(retired: ${why})` });
      return { ok: true, digest: `retired ${target.title}`, content: `Retired ${id}.` };
    },
  };
}
