import { compile, formatProblems, type Known } from '../compile.js';
import { planFor } from '../image.js';
import type { ImageBuilder } from './image-builder.js';
import type { ToolDefinition } from '../catalogue.js';
import { formatAgent, formatLoop } from '../syntax.js';
import { refuse, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import type { AgentDefinition } from '../agent.js';
import type { LoopGraph } from '../graph.js';

export interface AgentSource {
  slug: string;
  ownerId?: string | undefined;
  version: string;
  source: string;
  updatedAt: string;
}

export interface SourceStore {
  get(ownerId: string, slug: string): Promise<AgentSource | undefined>;
  save(source: AgentSource): Promise<void>;
}

export interface BuilderScope {
  agents(ownerId: string): Promise<AgentDefinition[]>;
  loops(ownerId: string): Promise<LoopGraph[]>;
  catalogue(ownerId: string): Promise<ToolDefinition[]>;
  granted(ownerId: string, agentSlug: string): Promise<string[]>;
}

export interface BuilderToolOptions {
  store: SourceStore;
  scope: BuilderScope;
  images: ImageBuilder;
  now?: (() => string) | undefined;
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

async function knownIn(scope: BuilderScope, ownerId: string): Promise<Known> {
  const [agents, loops, tools] = await Promise.all([
    scope.agents(ownerId),
    scope.loops(ownerId),
    scope.catalogue(ownerId),
  ]);

  return {
    agents: new Set(agents.map((agent) => agent.slug)),
    loops: new Set(loops.map((loop) => loop.id)),
    tools: new Set(tools.map((tool) => tool.name)),
  };
}

function overreach(written: readonly AgentDefinition[], granted: ReadonlySet<string>): string[] {
  const beyond = new Set<string>();

  for (const agent of written) {
    for (const tool of agent.tools) {
      if (!granted.has(tool)) beyond.add(tool);
    }
  }

  return [...beyond].sort();
}

export function createBuilderTools(options: BuilderToolOptions): Record<string, ToolHandler> {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async read_agent({ parsed, caller }): Promise<ToolOutcome> {
      const slug = asString(parsed, 'agent');
      if (!slug) return refuse('this call needs an "agent"');

      const ownerId = caller.ownerId ?? '';
      const stored = await options.store.get(ownerId, slug);
      if (stored) return { ok: true, digest: stored.source, content: stored.source };

      const agents = await options.scope.agents(ownerId);
      const found = agents.find((agent) => agent.slug === slug);
      if (!found) return refuse(`there is no agent called "${slug}"`);

      const loops = await options.scope.loops(ownerId);
      const loop = loops.find((candidate) => candidate.id === found.loop);

      const text = [formatAgent(found), loop ? formatLoop(loop) : ''].filter(Boolean).join('\n');
      return { ok: true, digest: text, content: text };
    },

    async compile_agent({ parsed, caller }): Promise<ToolOutcome> {
      const source = asString(parsed, 'source');
      if (!source) return refuse('this call needs a "source"');

      const built = compile(source, await knownIn(options.scope, caller.ownerId ?? ''));
      if (built.ok) {
        const named = [
          ...built.agents.map((agent) => `agent ${agent.slug}`),
          ...built.loops.map((loop) => `loop ${loop.id}`),
        ].join(', ');
        return { ok: true, digest: `compiles clean: ${named || 'nothing defined'}`, content: '' };
      }

      const report = formatProblems(built.problems);
      return { ok: false, digest: report, content: report };
    },

    async write_agent({ parsed, caller }): Promise<ToolOutcome> {
      const source = asString(parsed, 'source');
      if (!source) return refuse('this call needs a "source"');

      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to save an agent for');

      const known = await knownIn(options.scope, ownerId);
      const built = compile(source, known);

      if (!built.ok) {
        const report = formatProblems(built.problems);
        return { ok: false, digest: `not saved — it does not compile:\n${report}`, content: report };
      }

      if (built.agents.length === 0) {
        return refuse('this source defines no agent, so there is nothing to save');
      }

      const mine = new Set(await options.scope.granted(ownerId, caller.agentSlug ?? ''));
      const beyond = overreach(built.agents, mine);
      if (beyond.length > 0) {
        const why = `not saved — you cannot grant tools you do not have yourself: ${beyond.join(', ')}`;
        return { ok: false, digest: why, content: why };
      }

      const catalogue = await options.scope.catalogue(ownerId);

      for (const agent of built.agents) {
        try {
          const plan = planFor(agent, catalogue);
          if (plan) await options.images.ensure(plan);
        } catch (err) {
          const why = `not saved — ${agent.slug} needs a workspace that will not build:\n${(err as Error).message}`;
          return { ok: false, digest: why, content: why };
        }
      }

      const at = now();
      for (const agent of built.agents) {
        await options.store.save({
          slug: agent.slug,
          ownerId,
          version: agent.version,
          source,
          updatedAt: at,
        });
      }

      const saved = built.agents.map((agent) => agent.slug).join(', ');
      return { ok: true, digest: `saved ${saved} as your own copy`, content: '' };
    },
  };
}
