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
import type { Database } from './db-interface.js';
import { canAddChild, childrenOf, subtreeOf, wouldCycle, resolveDependencyTitles, dependentsOf, type Leaf } from './leaves.js';
import { usablePaths } from './leaf-artifacts.js';
import { usableAcceptancePlan } from './acceptance.js';
import { rewireDependents } from './plan-review.js';
import { summariseLeaf, detailLeaf, parseToolArguments } from './leaf-tools.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import { imageForLanguage, isWorkspaceLanguage, WORKSPACE_IMAGES } from './workspace-spec.js';

export interface LeafToolCall {
  name: string;
  arguments: string;
}

export interface LeafToolContext {
  db: Database;
  /** The session's user. Never a tool argument. */
  userId: string;
  branchId: string;
  webSearch: (query: string) => Promise<{ title: string; snippet: string; url: string }[]>;
  fetchWebPage: (url: string) => Promise<string>;
  projects: ProjectRepoService;
}

export async function runLeafTool(ctx: LeafToolContext, call: LeafToolCall): Promise<string> {
  const { db, userId, branchId, webSearch, fetchWebPage, projects } = ctx;
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
      const wantedPersona = typeof args.persona === 'string' ? args.persona.trim().toLowerCase() : '';
      const persona = wantedPersona
        ? ((await db.getPersonas()).filter((p) => p.ownerId === userId)).find((p) => p.name.trim().toLowerCase() === wantedPersona)
        : undefined;

      const now = new Date().toISOString();
      const leaf: Leaf = {
        id,
        ownerId: userId,
        branchId,
        title: title.slice(0, 200),
        ...(dependsOn.length ? { dependsOn } : {}),
        // Filtered here rather than at check time so the stored record only ever holds paths the
        // checker would act on — a leaf promising "../../etc/passwd" should not look like it has a
        // requirement nothing will ever test.
        ...(expects.length ? { expects } : {}),
        ...(persona ? { personaId: persona.id } : {}),
        ...(typeof args.body === 'string' && args.body.trim() ? { body: args.body.trim().slice(0, 4000) } : {}),
        // Silently dropped when it is not a known language: the model picking something outside
        // the enum should get the default sandbox, not a leaf that fails when it runs.
        ...(isWorkspaceLanguage(args.language) ? { language: args.language } : {}),
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

      return JSON.stringify({
        proposed: { id: leaf.id, title: leaf.title },
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
      });
      return JSON.stringify({
        created: { id: project.id, name: project.name, repo: `${project.giteaOwner}/${project.giteaRepo}` },
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

    if (call.name === 'set_leaf_workspace') {
      const leaf = leaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'No leaf with that id on this branch.' });
      if (!isWorkspaceLanguage(args.language)) {
        return JSON.stringify({ error: `Unknown language. Choose one of: ${Object.keys(WORKSPACE_IMAGES).join(', ')}.` });
      }
      // Allowed while proposed OR pending — unlike the text, the toolchain can still be corrected
      // after a human accepts, right up until the sandbox is built from it. After that the work
      // is already running somewhere and changing the image would mean nothing.
      if (leaf.status !== 'proposed' && leaf.status !== 'pending') {
        return JSON.stringify({ error: `That leaf is already ${leaf.status}; its sandbox exists and cannot be changed.` });
      }
      await db.saveLeaf({ ...leaf, language: args.language, updatedAt: new Date().toISOString() });
      return JSON.stringify({ updated: { id: leaf.id, language: args.language, image: imageForLanguage(args.language) } });
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
      if (!title && !body) return JSON.stringify({ error: 'Nothing to change — pass title, body, or both.' });

      const updated: Leaf = {
        ...leaf,
        ...(title ? { title: title.slice(0, 200) } : {}),
        ...(body ? { body: body.slice(0, 4000) } : {}),
        updatedAt: new Date().toISOString(),
      };
      await db.saveLeaf(updated);
      return JSON.stringify({ revised: { id: updated.id, title: updated.title } });
    }

    if (call.name === 'list_tool_repository') {
      const repo = [
        { id: 'web_search', name: 'Web Search', category: 'http', description: 'Live DuckDuckGo web search engine.' },
        { id: 'fetch_web_page', name: 'Fetch Web Page', category: 'http', description: 'Fetches clean text content from web URLs.' },
        { id: 'pytest_runner', name: 'PyTest Runner', category: 'testing', description: 'Executes Python unit test suites in sandbox.' },
        { id: 'git_inspector', name: 'Git Inspector', category: 'git', description: 'Inspects commit history, diffs, and branch refs.' },
        { id: 'linter_audit', name: 'Linter Audit', category: 'linter', description: 'Runs ESLint/Ruff/Static analysis check.' },
        { id: 'http_tester', name: 'HTTP Tester', category: 'http', description: 'Tests API endpoints and HTTP payloads.' },
      ];
      const category = typeof args.category === 'string' ? args.category : undefined;
      const filtered = category ? repo.filter((t) => t.category === category) : repo;
      return JSON.stringify({ tools: filtered });
    }

    if (call.name === 'attach_tool_to_leaf') {
      const leaf = leaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'No leaf with that id on this branch.' });
      const toolId = String(args.toolId ?? '');
      await db.saveLeaf({ ...leaf, attachedTools: [...(leaf as any).attachedTools ?? [], toolId], updatedAt: new Date().toISOString() } as any);
      return JSON.stringify({ attached: { leafId: leaf.id, toolId } });
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
