/**
 * Executing the tools a planning turn calls.
 *
 * ── WHY THIS LEFT THE ROUTE ──
 * This is where proposals are actually created, so anything measuring how well a model decomposes
 * work has to run THIS code — not a reimplementation of it. The Lab could previously only drive the
 * sandbox loop, and the first experiment written against the planning cycle asked the model to plan
 * and then checked a sandbox for a file the sandbox loop has no tool to produce. Scoring a
 * reimplementation would repeat that failure with more steps.
 *
 * Dependencies are passed rather than closed over so the same function serves an HTTP request and a
 * headless experiment run. Ownership still comes from `ctx.userId`, never from a tool argument —
 * see the schema tests: no tool takes an owner, because a prompt could then reach across tenants.
 */
import { v4 as uuidv4 } from 'uuid';
import { resolvePersonaNamed } from './proposal-merge.js';
import type { McpRegistryService } from '../services/McpRegistryService.js';
import type { Database } from './db-interface.js';
import { canAddChild, childrenOf, subtreeOf, wouldCycle, resolveDependencyTitles, dependentsOf, type Leaf } from './leaves.js';
import { usablePaths } from './leaf-artifacts.js';
import { normaliseLeafInput } from './leaf-input.js';
import { usableAcceptancePlan } from './acceptance.js';
import { rewireDependents } from './plan-review.js';
import { withProject } from './trees.js';
import { summariseLeaf, detailLeaf, parseToolArguments } from './leaf-tools.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import { isWorkspaceLanguage, DEFAULT_WORKSPACE_LANGUAGE } from './workspace-spec.js';

export interface LeafToolCall {
  name: string;
  arguments: string;
}

export interface LeafToolContext {
  db: Database;
  /**
   * Starting and inspecting a crawl.
   *
   * Optional because the chat path has a Temporal client and a worker-side caller may not. Absent
   * means the ingest tools report that ingestion is unavailable rather than appearing to work.
   */
  ingest?: {
    start: (args: { ownerId: string; url: string; maxDepth?: number; maxPages?: number; domains?: string[]; keywords?: string[] }) => Promise<{ workflowId: string }>;
    status: (workflowId: string) => Promise<{ state: string; receipt?: unknown; error?: string }>;
    search: (args: { ownerId: string; query: string; ingestId?: string }) => Promise<{ hits: { url: string; snippet: string }[] }>;
  };
  /** The session's user. Never a tool argument. */
  userId: string;
  branchId: string;
  webSearch: (query: string) => Promise<{ title: string; snippet: string; url: string }[]>;
  fetchWebPage: (url: string) => Promise<string>;
  projects: ProjectRepoService;
  /**
   * What MCP servers this user has running, for planning against.
   *
   * Optional for the same reason `ingest` is: a worker-side caller may have no way to reach the
   * cluster for a NodePort. Absent makes `list_mcp_servers` say so — never report an empty list,
   * which a planner reads as "none exist" and plans to rebuild something already running.
   */
  mcpRegistry?: Pick<McpRegistryService, 'listWithTools'>;
}

export async function runLeafTool(ctx: LeafToolContext, call: LeafToolCall): Promise<string> {
  const { db, userId, branchId, webSearch, fetchWebPage, projects, ingest, mcpRegistry } = ctx;
  const args = parseToolArguments(call.arguments);
  const leaves = ((await db.getLeaves()).filter((l) => l.ownerId === userId)).filter((l) => l.branchId === branchId);

  try {
    if (call.name === 'list_leaves') {
      const status = typeof args.status === 'string' ? args.status : undefined;
      const filtered = status ? leaves.filter((l) => l.status === status) : leaves;
      return JSON.stringify({ leaves: filtered.map(summariseLeaf) });
    }

    if (call.name === 'get_leaf') {
      const leaf = leaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'No leaf with that id on this branch.' });
      return JSON.stringify(detailLeaf(leaf, childrenOf(leaves, leaf.id)));
    }

    if (call.name === 'start_ingest' || call.name === 'ingest_status' || call.name === 'search_corpus') {
      if (!ingest) {
        return JSON.stringify({ error: 'Ingestion is not available here.' });
      }

      if (call.name === 'start_ingest') {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!/^https?:\/\//i.test(url)) return JSON.stringify({ error: 'url must be an http or https address.' });
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
        const started = await ingest.start({
          ownerId: userId,
          url,
          // Bounded here as well as in the crawl config: these arrive as untrusted JSON, and a
          // depth of 12 is not a crawl, it is an outage.
          ...(num(args.maxDepth) !== undefined ? { maxDepth: Math.min(Math.max(0, num(args.maxDepth)!), 4) } : {}),
          ...(num(args.maxPages) !== undefined ? { maxPages: Math.min(Math.max(1, num(args.maxPages)!), 2000) } : {}),
          ...(list(args.domains)?.length ? { domains: list(args.domains)! } : {}),
          ...(list(args.keywords)?.length ? { keywords: list(args.keywords)! } : {}),
        });
        return JSON.stringify({
          started: { id: started.workflowId, url },
          // Said explicitly: the model will otherwise wait for pages that are never coming.
          note: 'The crawl is running in the background. No pages will be returned to you — check ingest_status, then use search_corpus.',
        });
      }

      if (call.name === 'ingest_status') {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return JSON.stringify({ error: 'id is required.' });
        return JSON.stringify(await ingest.status(id));
      }

      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return JSON.stringify({ error: 'query is required.' });
      const found = await ingest.search({
        ownerId: userId,
        query,
        ...(typeof args.ingestId === 'string' && args.ingestId ? { ingestId: args.ingestId } : {}),
      });
      return JSON.stringify({
        query,
        hits: found.hits,
        ...(found.hits.length ? {} : { note: 'Nothing in the corpus matches. Has the crawl finished?' }),
      });
    }

    if (call.name === 'list_personas') {
      // Name and description only: the model assigns by name, and its prompt and knobs are not
      // its business.
      const mine = (await db.getPersonas()).filter((p) => p.ownerId === userId);
      return JSON.stringify({
        personas: mine.map((p) => ({ name: p.name, description: p.description ?? '' })),
      });
    }

    if (call.name === 'propose_leaf') {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) return JSON.stringify({ error: 'title is required' });

      // The same caps the HTTP route enforces. A tool is not a way around them.
      const parent = args.parentLeafId ? leaves.find((l) => l.id === String(args.parentLeafId)) : undefined;
      if (args.parentLeafId && !parent) return JSON.stringify({ error: 'No leaf with that parentLeafId.' });
      if (parent) {
        const refusal = canAddChild(parent, childrenOf(leaves, parent.id).length);
        if (refusal) return JSON.stringify({ error: refusal });
      }

      /**
       * Dependencies arrive as TITLES and are resolved here — see `resolveDependencyTitles` for
       * why titles, why a miss is not fatal, and why the misses come back rather than vanishing.
       */
      const id = uuidv4();
      const wanted = Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [];
      const { ids: dependsOn, unresolved } = resolveDependencyTitles(wanted, leaves);
      const expects = usablePaths(Array.isArray(args.expects) ? args.expects.map(String) : []);
      if (wouldCycle(id, dependsOn, leaves)) {
        // Refused rather than dropped: a cycle does not fail, it waits forever, and every leaf
        // in it looks like work that is merely slow.
        return JSON.stringify({ error: 'Those dependencies would form a cycle — nothing in it could ever start.' });
      }

      /**
       * Resolved by name, and dropped when it matches nothing.
       *
       * A name the model invented is not a reason to refuse the leaf — the work is still valid
       * and still gets done, just by the default configuration. Refusing would trade a real
       * proposal for a spelling mistake.
       */
      const wantedPersona = typeof args.persona === 'string' ? args.persona.trim() : '';
      const persona = resolvePersonaNamed(
        wantedPersona,
        (await db.getPersonas()).filter((p) => p.ownerId === userId),
      );

      const now = new Date().toISOString();
      const leaf: Leaf = {
        id,
        ownerId: userId,
        branchId,
        // Shared with the HTTP route — see lib/leaf-input.ts for why these are not named twice.
        ...normaliseLeafInput(args),
        title: title.slice(0, 200),
        ...(dependsOn.length ? { dependsOn } : {}),
        ...(persona ? { personaId: persona.id } : {}),
        column: 'todo',
        // Proposed, always. A tool call is still the model suggesting, not deciding.
        status: 'proposed',
        depth: parent ? parent.depth + 1 : 0,
        blocking: true,
        ...(parent ? { parentLeafId: parent.id } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await db.saveLeaf(leaf);
      /**
       * The result states what was actually recorded, not just that something was.
       *
       * `dependsOn` is echoed back by TITLE because that is what the model wrote and what it can
       * check against its own plan — an id it has never seen tells it nothing. When something
       * matched nothing, the existing titles come with it, so the next call can name one correctly
       * instead of guessing again.
       */
      const recorded = dependsOn
        .map((depId) => leaves.find((l) => l.id === depId)?.title)
        .filter((t): t is string => Boolean(t));

      /**
       * Whether anyone is actually going to do this.
       *
       * Reported in the same breath as the proposal, because a persona now carries the entire
       * environment — image, network, tools, budget, where the output goes — so a leaf without one
       * cannot run at all. The old behaviour was to drop an unmatched name silently and let the
       * work fall back to a default configuration; there is no such default now, and saying nothing
       * would hand back a proposal that looks accepted and is not runnable.
       *
       * The available names travel with the warning, since the usual cause is a model that never
       * had them.
       */
      const personaWarning = persona
        ? undefined
        : wantedPersona
          ? `No persona is named "${args.persona}", so this leaf has nobody assigned and cannot run. Call revise_leaf with a name from availablePersonas.`
          : 'This leaf has no persona, so nobody is assigned to it and it cannot run. A persona decides the toolchain, the network access, the tools and the time budget. Call revise_leaf with a name from availablePersonas.';

      return JSON.stringify({
        proposed: { id: leaf.id, title: leaf.title },
        ...(personaWarning
          ? {
              personaWarning,
              availablePersonas: ((await db.getPersonas()).filter((p) => p.ownerId === userId))
                .map((p) => ({ name: p.name, description: p.description ?? '' })),
            }
          : { persona: persona!.name }),
        // Echoed so a path that was dropped for looking unsafe does not silently become a promise
        // nothing will check.
        ...(expects.length ? { expects } : {}),
        ...(wanted.length ? { dependsOn: recorded } : {}),
        ...(unresolved.length
          ? {
              // Named `warning` rather than buried in a field the model may not read: this leaf
              // will start immediately alongside the work it was supposed to follow.
              warning: `These dependencies matched no leaf and were NOT recorded, so this leaf will start immediately instead of waiting: ${unresolved.map((t) => `"${t}"`).join(', ')}. Use a title exactly as it appears in existingTitles, or propose the missing leaf first.`,
              unresolvedDependencies: unresolved,
              existingTitles: leaves.map((l) => l.title),
            }
          : {}),
      });
    }

    if (call.name === 'set_acceptance') {
      // `checks` is the plan; a bare `command` is what the first version took, and accepting it
      // still costs nothing.
      const plan = usableAcceptancePlan(args.checks ?? args.command);
      if (plan.length === 0) {
        // Refused rather than stored: the value of showing this to a human before they accept
        // depends on what they read being all of what runs.
        return JSON.stringify({
          error: 'No usable checks. Each needs a name and a single-line command, with no command '
            + 'substitution, backgrounding, or chaining beyond `&&`.',
        });
      }
      const branches = await db.getBranches();
      const branch = branches.find((b) => b.id === branchId && b.ownerId === userId);
      if (!branch) return JSON.stringify({ error: 'No such branch.' });
      await db.saveBranch({ ...branch, acceptance: plan, updatedAt: new Date().toISOString() });
      // Echoed back so a check dropped for being malformed does not silently become a promise
      // nothing will run.
      return JSON.stringify({ acceptance: plan });
    }

    if (call.name === 'list_projects') {
      // ownerId comes from the SESSION, never from the model. A projectId argument could name
      // anyone's repository; the user it belongs to is not the model's to choose.
      const mine = await projects.listForOwner(userId);
      return JSON.stringify({
        projects: mine.map((p) => ({ id: p.id, name: p.name, repo: `${p.giteaOwner}/${p.giteaRepo}` })),
      });
    }

    if (call.name === 'create_project') {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return JSON.stringify({ error: 'name is required' });
      const project = await projects.register(userId, name, {
        ...(typeof args.description === 'string' && args.description.trim()
          ? { description: args.description.trim().slice(0, 300) }
          : {}),
        // Validated rather than trusted: it arrives as untrusted JSON, and an unrecognised
        // toolchain would resolve to no image at all.
        ...(isWorkspaceLanguage(args.language) ? { language: args.language } : {}),
      });
      /**
       * The tree learns about it NOW, not when a leaf happens to finish.
       *
       * ── THE RUN THIS SPLIT ──
       * Creating a project used to attach it to nothing: it returned an id and relied on the model
       * calling `set_leaf_project` for every leaf. A real planning turn created `github-mcp` and
       * then did not, so each leaf resolved no project, fell through to the per-branch fallback,
       * and built in `koala-request-30b2d228` — while `github-mcp` sat empty and unused.
       *
       * Worse, it could not be recovered afterwards: the first leaf to FINISH calls `withProject`
       * with whatever it resolved, so the fallback became the tree's primary repository
       * permanently, and every later branch of the same effort joined it too.
       *
       * Attaching here makes the named project `projectIds[0]`, which is what `resolveLeafProject`
       * reads as `treeProjectId` — so every leaf of the branch lands in it without the model
       * needing a second step it demonstrably does not take. The executor's own attach then finds
       * the id already present and does nothing.
       */
      let attachedTo: string | undefined;
      const branch = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === userId);
      if (branch?.treeId) {
        const tree = (await db.getTrees()).find((t) => t.id === branch.treeId && t.ownerId === userId);
        // Re-read and append; saveTree is a full replace, and `withProject` keeps the first
        // repository primary so this never hijacks a tree that already has one.
        if (tree) {
          await db.saveTree(withProject(tree, project.id));
          attachedTo = tree.name;
        }
      }

      return JSON.stringify({
        created: {
          id: project.id, name: project.name, repo: `${project.giteaOwner}/${project.giteaRepo}`,
          // Echoed, so a dropped language is visible rather than silently becoming the default.
          language: project.language ?? DEFAULT_WORKSPACE_LANGUAGE,
        },
        // Said explicitly so the model does not also try to point each leaf at it by hand.
        ...(attachedTo
          ? { note: `Leaves on this branch will use this repository by default — no need to set it per leaf.` }
          : {}),
      });
    }

    if (call.name === 'set_leaf_project') {
      const leaf = leaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'No leaf with that id on this branch.' });
      // Resolved through the owner-filtered list, so naming another user's project id reads as
      // "no such project" rather than attaching their repo to this leaf.
      const project = (await projects.listForOwner(userId))
        .find((p) => p.id === String(args.projectId ?? ''));
      if (!project) return JSON.stringify({ error: 'No project with that id.' });
      if (leaf.status !== 'proposed' && leaf.status !== 'pending') {
        return JSON.stringify({ error: `That leaf is already ${leaf.status}; its sandbox exists and cannot be repointed.` });
      }
      await db.saveLeaf({ ...leaf, projectId: project.id, updatedAt: new Date().toISOString() });
      return JSON.stringify({ updated: { id: leaf.id, projectId: project.id, repo: `${project.giteaOwner}/${project.giteaRepo}` } });
    }

// Both editing verbs stop at 'proposed'. Once a human has accepted a leaf there may be a
    // workflow running against its text, and the model rewriting or deleting it underneath would
    // change what the work means after the person agreed to it.
    if (call.name === 'replace_leaf') {
      const old = leaves.find((l) => l.id === String(args.id ?? ''));
      if (!old) return JSON.stringify({ error: 'No leaf with that id on this branch.' });
      if (old.status !== 'proposed') {
        return JSON.stringify({
          error: `That leaf is already ${old.status}, so it is no longer yours to change. Say what you would do differently and let the user decide.`,
        });
      }
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) return JSON.stringify({ error: 'title is required' });

      const now = new Date().toISOString();
      const replacement: Leaf = {
        ...old,
        id: uuidv4(),
        title: title.slice(0, 200),
        ...(typeof args.body === 'string' && args.body.trim() ? { body: args.body.trim().slice(0, 4000) } : {}),
        ...(Array.isArray(args.expects) ? { expects: usablePaths(args.expects.map(String)) } : {}),
        ...(isWorkspaceLanguage(args.language) ? { language: args.language } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await db.saveLeaf(replacement);

      /**
       * Dependents move BEFORE the old leaf goes.
       *
       * `dependenciesMet` treats an id that resolves to nothing as met, so between the delete and
       * the rewire a dependent is a leaf whose ordering has silently evaporated. Doing it in this
       * order means that window does not exist.
       */
      const moved = rewireDependents(leaves, old.id, replacement.id);
      for (const l of moved) await db.saveLeaf({ ...l, updatedAt: now });
      await db.deleteLeaf(old.id);

      return JSON.stringify({
        replaced: { was: old.title, now: replacement.title, id: replacement.id },
        // Reported so the model can see the ordering survived rather than assuming it.
        ...(moved.length ? { movedDependents: moved.map((l) => l.title) } : {}),
      });
    }

    if (call.name === 'revise_leaf' || call.name === 'withdraw_leaf') {
      const leaf = leaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'No leaf with that id on this branch.' });
      if (leaf.status !== 'proposed') {
        return JSON.stringify({
          error: `That leaf is already ${leaf.status}, so it is no longer yours to change. Say what you would do differently and let the user decide.`,
        });
      }

      if (call.name === 'withdraw_leaf') {
        // Children would be orphaned into an unreachable subtree, so they go too — safe here
        // because everything below a proposal is itself still a proposal.
        const doomed = [leaf, ...childrenOf(leaves, leaf.id)];
        /**
         * Anything that named it loses the ordering, silently.
         *
         * A deleted dependency resolves to nothing, and `dependenciesMet` counts that as met — so
         * the dependent does not wait, it starts early with no trace of why. Reported rather than
         * prevented, and `replace_leaf` is the way to avoid it.
         */
        const orphaned = doomed.flatMap((d) => dependentsOf(d.id, leaves))
          .filter((l) => !doomed.some((d) => d.id === l.id));
        for (const l of doomed) await db.deleteLeaf(l.id);
        return JSON.stringify({
          withdrawn: { id: leaf.id, title: leaf.title, alsoRemoved: doomed.length - 1 },
          ...(orphaned.length
            ? {
                warning: `${orphaned.map((l) => `"${l.title}"`).join(', ')} depended on this and will now `
                  + 'start without waiting for anything. Use replace_leaf if you meant to substitute it.',
              }
            : {}),
        });
      }

      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const body = typeof args.body === 'string' ? args.body.trim() : '';
      /**
       * Assigning somebody is a revision like any other.
       *
       * Without this the re-ask loop asked the model to do something no tool could do: the prompt
       * said "call revise_leaf setting persona" and the parameter did not exist, so every attempt
       * to repair an unassigned leaf would have failed silently and gone to the user as unassignable.
       */
      const wantedPersona = typeof args.persona === 'string' ? args.persona.trim() : '';
      const mine = (await db.getPersonas()).filter((p) => p.ownerId === userId);
      const persona = resolvePersonaNamed(wantedPersona, mine);
      if (wantedPersona && !persona) {
        return JSON.stringify({
          error: `No persona is named "${args.persona}".`,
          availablePersonas: mine.map((p) => ({ name: p.name, description: p.description ?? '' })),
        });
      }
      if (!title && !body && !persona) {
        return JSON.stringify({ error: 'Nothing to change — pass title, body, persona, or a combination.' });
      }

      const updated: Leaf = {
        ...leaf,
        ...(title ? { title: title.slice(0, 200) } : {}),
        ...(body ? { body: body.slice(0, 4000) } : {}),
        ...(persona ? { personaId: persona.id } : {}),
        updatedAt: new Date().toISOString(),
      };
      await db.saveLeaf(updated);
      return JSON.stringify({
        revised: { id: updated.id, title: updated.title, ...(persona ? { persona: persona.name } : {}) },
      });
    }

    if (call.name === 'list_mcp_servers') {
      /**
       * The same registry the executor uses, so what a plan is told exists is what a leaf will
       * actually find. Absent when the caller could not supply one — reported as unavailable rather
       * than as an empty list, because "no servers" and "cannot see servers" lead a planner to
       * opposite decisions.
       */
      if (!mcpRegistry) {
        return JSON.stringify({
          error: 'The MCP registry is not available here, so it is not known which servers exist. Do not conclude there are none.',
        });
      }
      const servers = await mcpRegistry.listWithTools(args.refresh === true);
      if (!servers.length) {
        return JSON.stringify({
          servers: [],
          note: 'No MCP servers are deployed under this account yet. Building and deploying one makes its tools callable from a leaf.',
        });
      }
      /**
       * Same owner-scoped listing `list_projects` uses; the session decides, never the model.
       *
       * Wrapped because the NAME is a convenience and the id is the part that works: a project
       * lookup that fails must not take the server list down with it. `try` rather than `.catch`
       * — a missing dependency throws synchronously, which a promise catch never sees.
       */
      let mine: { id: string; name: string }[] = [];
      try { mine = (await projects.listForOwner(userId)) as any[]; } catch { mine = []; }
      const editable = servers.filter((s) => s.projectId);
      return JSON.stringify({
        servers: servers.map((s) => ({
          name: s.name,
          status: s.unreachable ? 'unreachable' : 'running',
          // Kept: a server that is deployed but not answering is a fixable problem, and hiding the
          // reason turns it into a server that silently has no tools.
          ...(s.unreachable ? { unreachable: s.unreachable } : {}),
          tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })),
          /**
           * What turns a server from something to CALL into something to CHANGE. Given as a
           * project id because that is what `set_leaf_project` takes — a name would have to be
           * matched back, and two projects can share one.
           */
          ...(s.projectId
            ? {
                projectId: s.projectId,
                projectName: mine.find((p: any) => p.id === s.projectId)?.name,
              }
            : {}),
        })),
        ...(editable.length
          ? {
              note:
                'To change a server rather than call it — adding a tool, fixing one — propose leaves '
                + 'and set each one\'s project to that server\'s projectId with set_leaf_project. The leaf '
                + 'then works in the repository the server is built from, and merging rebuilds and '
                + 'redeploys it. Building a second server instead leaves the running one unchanged.',
            }
          : {}),
      });
    }

    if (call.name === 'update_leaf_memory') {
      const category = String(args.category ?? 'lessons_learned');
      const title = String(args.title ?? '');
      const text = String(args.text ?? '');
      return JSON.stringify({ savedMemory: { category, title, text, timestamp: new Date().toISOString() } });
    }

    if (call.name === 'web_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'query parameter is required' });
      const results = await webSearch(query);
      return JSON.stringify({ query, results: results.length ? results : [{ snippet: 'No results found or request failed' }] });
    }

    if (call.name === 'fetch_web_page') {
      const url = String(args.url ?? '').trim();
      if (!url) return JSON.stringify({ error: 'url parameter is required' });
      const content = await fetchWebPage(url);
      return JSON.stringify({ url, content });
    }

    return JSON.stringify({ error: `Unknown tool ${call.name}` });
  } catch (err: any) {
    return JSON.stringify({ error: String(err?.message ?? err).slice(0, 300) });
  }
}
