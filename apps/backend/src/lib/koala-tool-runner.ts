import { v4 as uuidv4 } from 'uuid';
import type { Database } from './db-interface.js';
import type { Conversation, ProposedTree, ProposedSpec } from './conversations.js';
import { withEnabled, enabledForSession } from './conversations.js';
import { preferUsable, type McpServer } from './mcp-registry.js';
import { TREE_TYPES } from './trees.js';
import { rollup } from './tree-board.js';
import { describeInfrastructure } from './infrastructure.js';
import { validateSpec, explainSpecProblems } from './app-spec-validate.js';
import type { AppSpec } from './app-spec.js';

/**
 * Executing the tools a general-chat turn calls.
 *
 * Separate from `runLeafTool` because the two share no vocabulary: that one acts on a branch and
 * every call is scoped to one, and none of this is. Ownership still comes from the session and never
 * from a tool argument — the same rule, for the same reason.
 */

export interface KoalaToolContext {
  db: Database;
  userId: string;
  conversationId: string;
  sessionId?: string | undefined;
  /** Everything deployed for this user, already collapsed by name. */
  servers: readonly McpServer[];
  webSearch: (query: string) => Promise<{ title: string; snippet: string; url: string }[]>;
  fetchWebPage: (url: string) => Promise<string>;
}

export interface KoalaToolResult {
  /** What goes back to the model. */
  content: string;
  /**
   * A server hooked up by this call, so the caller can widen the tool list for the NEXT round.
   *
   * Returned rather than applied here because the tool list belongs to the turn, not the database:
   * a model that enables a service and then cannot call it until the user sends another message has
   * been given a mechanism that does not work.
   */
  enabled?: string;
  /** A project proposed by this call, for the reply to carry back to the UI. */
  proposed?: ProposedTree;
  /** An app type proposed by this call. */
  proposedSpec?: ProposedSpec;
}

const json = (value: unknown): KoalaToolResult => ({ content: JSON.stringify(value) });

export async function runKoalaTool(
  ctx: KoalaToolContext,
  call: { name: string; arguments: string },
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers } = ctx;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    // Malformed arguments are the model's mistake to correct, not a reason to fail the turn.
    return json({ error: 'Could not read those arguments as JSON.' });
  }

  try {
    if (call.name === 'list_mcp_servers') {
      const usable = preferUsable(servers);
      if (!usable.length) {
        return json({
          servers: [],
          note: 'Nothing is deployed under this account yet. Propose a project to build something.',
        });
      }
      return json({
        servers: usable.map((s) => ({
          name: s.name,
          status: s.unreachable ? 'unreachable' : 'running',
          ...(s.unreachable ? { unreachable: s.unreachable } : {}),
          tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })),
        })),
      });
    }

    if (call.name === 'enable_mcp_server') {
      const wanted = typeof args.name === 'string' ? args.name.trim() : '';
      if (!wanted) return json({ error: 'name is required.' });

      const found = preferUsable(servers).find((s) => s.name === wanted);
      if (!found) {
        // Names the real ones: a model that guessed will otherwise guess again.
        return json({
          error: `No service named "${wanted}".`,
          available: preferUsable(servers).map((s) => s.name),
        });
      }
      if (found.unreachable || !found.tools.length) {
        /**
         * Refused rather than enabled-with-nothing. Loading a service that cannot answer gives the
         * model tools whose every call fails, and it will spend the rest of the conversation
         * reasoning about errors that have one cause it cannot see.
         */
        return json({
          error: `"${wanted}" is deployed but not answering${found.unreachable ? `: ${found.unreachable}` : ' — it exposes no tools'}.`,
        });
      }

      const conversation = (await db.getConversations())
        .find((c) => c.id === conversationId && c.ownerId === userId);
      if (!conversation) return json({ error: 'This conversation no longer exists.' });

      const already = enabledForSession(conversation, sessionId).includes(wanted);
      if (!already) await db.saveConversation(withEnabled(conversation, sessionId, wanted));

      return {
        content: JSON.stringify({
          enabled: wanted,
          ...(already ? { note: 'It was already hooked up; its tools are available.' } : {}),
          tools: found.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
        }),
        enabled: wanted,
      };
    }

    if (call.name === 'list_infrastructure') {
      const infra = describeInfrastructure(await db.getDeployments(), userId);
      return json({
        running: infra.running,
        deployable: infra.deployable,
        /**
         * Said plainly, because the absence is the part that gets ignored. A model reading a list
         * of twenty-six app types will not notice that `mongo` is not among them unless told what
         * the list means.
         */
        note: 'Anything not in `running` and not in `deployable` does not exist here and cannot be '
          + 'built — say so rather than planning around it. Connection addresses are resolved when a '
          + 'service is deployed; do not invent one.',
      });
    }

    if (call.name === 'propose_spec') {
      /**
       * Validated here, not at acceptance.
       *
       * A refusal reaching the model in the turn that wrote the spec is one it can act on — it has
       * the context and can fix it. The same check runs again on accept, because a proposal can sit
       * for a week and the rules can change under it.
       */
      const problems = validateSpec(args);
      if (problems.length) {
        return json({ error: explainSpecProblems(problems) });
      }

      const conversation = (await db.getConversations())
        .find((c) => c.id === conversationId && c.ownerId === userId);
      if (!conversation) return json({ error: 'This conversation no longer exists.' });

      const spec = args as unknown as AppSpec;
      // An id already in the catalogue would be an edit, not an addition, and those are different
      // decisions — one replaces something people may be running.
      const taken = (await db.getAppSpecs()).some((s) => s.id === spec.id);
      if (taken) {
        return json({ error: `"${spec.id}" is already deployable. Nothing to add.` });
      }

      const proposal: ProposedSpec = {
        id: spec.id,
        spec,
        proposedAt: new Date().toISOString(),
      };
      await db.saveConversation({
        ...conversation,
        proposedSpecs: [...(conversation.proposedSpecs ?? []), proposal],
        updatedAt: proposal.proposedAt,
      });
      return {
        content: JSON.stringify({
          proposed: { id: spec.id, image: spec.image },
          note: 'Proposed only. It is not deployable until the user accepts it.',
        }),
        proposedSpec: proposal,
      };
    }

    if (call.name === 'list_trees') {
      const trees = (await db.getTrees()).filter((t) => t.ownerId === userId);
      const branches = (await db.getBranches()).filter((b) => b.ownerId === userId);
      const leaves = (await db.getLeaves()).filter((l) => l.ownerId === userId);
      return json({
        trees: trees.map((t) => {
          const ids = new Set(branches.filter((b) => b.treeId === t.id).map((b) => b.id));
          const mine = leaves.filter((l) => ids.has(l.branchId));
          // The same rollup the board renders, so what Koala says matches what the user sees.
          const counts = rollup(mine, () => false);
          return {
            id: t.id,
            name: t.name,
            ...(t.goal ? { goal: t.goal } : {}),
            ...(t.serviceName ? { serviceName: t.serviceName } : {}),
            work: counts,
          };
        }),
      });
    }

    if (call.name === 'propose_tree') {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      if (!name) return json({ error: 'name is required.' });
      if (!goal) return json({ error: 'goal is required — it is what the planner reads later.' });

      // Validated against the same list the HTTP route enforces; an unrecognised type becomes the
      // fallback rather than a refusal, since the name and goal are the parts that matter.
      const wantedType = typeof args.type === 'string' ? args.type.trim() : '';
      const type = TREE_TYPES.some((t) => t.id === wantedType) ? wantedType : (TREE_TYPES[0]!.id);

      const conversation = (await db.getConversations())
        .find((c) => c.id === conversationId && c.ownerId === userId);
      if (!conversation) return json({ error: 'This conversation no longer exists.' });

      const proposal: ProposedTree = {
        id: uuidv4(),
        name: name.slice(0, 120),
        type,
        goal: goal.slice(0, 2000),
        proposedAt: new Date().toISOString(),
      };
      await db.saveConversation({
        ...conversation,
        proposedTrees: [...(conversation.proposedTrees ?? []), proposal],
        updatedAt: proposal.proposedAt,
      });
      return {
        content: JSON.stringify({
          proposed: { name: proposal.name, type: proposal.type },
          // Said plainly so the model does not tell the user it has started building.
          note: 'Proposed only. Nothing is created until the user accepts it.',
        }),
        proposed: proposal,
      };
    }

    if (call.name === 'web_search') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return json({ error: 'query is required.' });
      return json({ results: await ctx.webSearch(query) });
    }

    if (call.name === 'fetch_web_page') {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) return json({ error: 'url must be an http or https address.' });
      return json({ text: (await ctx.fetchWebPage(url)).slice(0, 20000) });
    }

    return json({ error: `No tool named "${call.name}".` });
  } catch (err: any) {
    // A tool that throws must not take the conversation down with it.
    return json({ error: `That call failed: ${String(err?.message ?? err).slice(0, 300)}` });
  }
}
