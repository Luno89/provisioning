import { gate, ALL_EFFECTS, type ToolEffect } from './action-gate.js';
import { effectOf, offeredOn } from './tool-catalogue.js';
import { v4 as uuidv4 } from 'uuid';
import { resolvePersonaNamed } from './proposal-merge.js';
import type { McpRegistryService } from '../services/McpRegistryService.js';
import type { Database } from './db-interface.js';
import { canAddChild, childrenOf, subtreeOf, wouldCycle, resolveDependencyTitles, dependentsOf, type Leaf } from './leaves.js';
import { usablePaths } from './leaf-artifacts.js';
import { normaliseLeafInput } from './leaf-input.js';
import { usableAcceptancePlan } from './acceptance.js';
import { hollowChecks, explainHollow } from './acceptance-validation.js';
import { rewireDependents } from './plan-review.js';
import { withProject } from './trees.js';
import { describeInfrastructure } from './infrastructure.js';
import { declareDependency } from './declare-dependency.js';
import { summariseLeaf, detailLeaf, parseToolArguments } from './leaf-tools.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import { DEFAULT_WORKSPACE_LANGUAGE } from './workspace-spec.js';
import { isWorkspaceLanguage } from './workspace-image-catalogue.js';
import { renderSearchOutcome, type WebSearchFn } from './web-tools.js';
import { withBuiltIns } from './ownership.js';

export interface LeafToolCall {
  name: string;
  arguments: string;
}

export interface LeafToolContext {
  db: Database;
  ingest?: {
    start: (args: { ownerId: string; url: string; maxDepth?: number; maxPages?: number; domains?: string[]; keywords?: string[] }) => Promise<{ workflowId: string }>;
    status: (workflowId: string) => Promise<{ state: string; receipt?: unknown; error?: string }>;
    search: (args: { ownerId: string; query: string; ingestId?: string }) => Promise<{ hits: { url: string; snippet: string }[] }>;
  };
  userId: string;
  branchId: string;
  webSearch: WebSearchFn;
  fetchWebPage: (url: string) => Promise<string>;
  projects: ProjectRepoService;
  mcpRegistry?: Pick<McpRegistryService, 'listWithTools'>;
  permitted?: readonly ToolEffect[] | undefined;
}

export async function runLeafTool(ctx: LeafToolContext, call: LeafToolCall): Promise<string> {
  const { db, userId, branchId, webSearch, fetchWebPage, projects, ingest, mcpRegistry } = ctx;
  const args = parseToolArguments(call.arguments);

  const rows = withBuiltIns(await db.getTools(), userId, (t) => t.name);
  if (!offeredOn(rows, 'planning', call.name)) {
    return JSON.stringify({ error: `Unknown tool ${call.name}` });
  }

  const decision = gate(
    call.name,
    effectOf(rows, call.name),
    ctx.permitted ?? ALL_EFFECTS,
  );
  if (!decision.allowed) return JSON.stringify({ error: decision.reason });

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
          ...(num(args.maxDepth) !== undefined ? { maxDepth: Math.min(Math.max(0, num(args.maxDepth)!), 4) } : {}),
          ...(num(args.maxPages) !== undefined ? { maxPages: Math.min(Math.max(1, num(args.maxPages)!), 2000) } : {}),
          ...(list(args.domains)?.length ? { domains: list(args.domains)! } : {}),
          ...(list(args.keywords)?.length ? { keywords: list(args.keywords)! } : {}),
        });
        return JSON.stringify({
          started: { id: started.workflowId, url },
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
      const mine = withBuiltIns(await db.getPersonaPacks(), userId, (p) => p.slug);
      return JSON.stringify({
        personas: mine.map((p) => ({ name: p.name, description: p.description ?? '' })),
      });
    }

    if (call.name === 'propose_leaf') {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) return JSON.stringify({ error: 'title is required' });

      const parent = args.parentLeafId ? leaves.find((l) => l.id === String(args.parentLeafId)) : undefined;
      if (args.parentLeafId && !parent) return JSON.stringify({ error: 'No leaf with that parentLeafId.' });
      if (parent) {
        const refusal = canAddChild(parent, childrenOf(leaves, parent.id).length);
        if (refusal) return JSON.stringify({ error: refusal });
      }

      const id = uuidv4();
      const wanted = Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [];
      const { ids: dependsOn, unresolved } = resolveDependencyTitles(wanted, leaves);
      const expects = usablePaths(Array.isArray(args.expects) ? args.expects.map(String) : []);
      if (wouldCycle(id, dependsOn, leaves)) {
        return JSON.stringify({ error: 'Those dependencies would form a cycle — nothing in it could ever start.' });
      }

      const wantedPersona = typeof args.persona === 'string' ? args.persona.trim() : '';
      const persona = resolvePersonaNamed(
        wantedPersona,
        (await db.getPersonaPacks()).filter((p) => p.ownerId == null || p.ownerId === userId),
      );

      const wantedProjectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      const wantedProject = wantedProjectId
        ? (await projects.listForOwner(userId)).find((p) => p.id === wantedProjectId)
        : undefined;
      if (wantedProjectId && !wantedProject) {
        console.warn(`[leaf-tools] branch ${branchId}: no project ${wantedProjectId} for "${title.slice(0, 40)}"`);
      }

      const now = new Date().toISOString();
      const leaf: Leaf = {
        id,
        ownerId: userId,
        branchId,
        ...normaliseLeafInput(args),
        title: title.slice(0, 200),
        ...(dependsOn.length ? { dependsOn } : {}),
        ...(persona ? { packId: persona.id } : {}),
        ...(wantedProject ? { projectId: wantedProject.id } : {}),
        column: 'todo',
        status: 'proposed',
        depth: parent ? parent.depth + 1 : 0,
        blocking: true,
        ...(parent ? { parentLeafId: parent.id } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await db.saveLeaf(leaf);
      const recorded = dependsOn
        .map((depId) => leaves.find((l) => l.id === depId)?.title)
        .filter((t): t is string => Boolean(t));

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
              availablePersonas: (withBuiltIns(await db.getPersonas(), userId, (p) => p.name))
                .map((p) => ({ name: p.name, description: p.description ?? '' })),
            }
          : { persona: persona!.name }),
        ...(expects.length ? { expects } : {}),
        ...(wanted.length ? { dependsOn: recorded } : {}),
        ...(unresolved.length
          ? {
              warning: `These dependencies matched no leaf and were NOT recorded, so this leaf will start immediately instead of waiting: ${unresolved.map((t) => `"${t}"`).join(', ')}. Use a title exactly as it appears in existingTitles, or propose the missing leaf first.`,
              unresolvedDependencies: unresolved,
              existingTitles: leaves.map((l) => l.title),
            }
          : {}),
      });
    }

    if (call.name === 'set_acceptance') {
      const plan = usableAcceptancePlan(args.checks ?? args.command);
      if (plan.length === 0) {
        return JSON.stringify({
          error: 'No usable checks. Each needs a name and a single-line command, with no command '
            + 'substitution, backgrounding, or chaining beyond `&&`.',
        });
      }
      const hollow = hollowChecks(plan);
      if (hollow.length) {
        return JSON.stringify({ error: explainHollow(hollow) });
      }

      const branches = await db.getBranches();
      const branch = branches.find((b) => b.id === branchId && b.ownerId === userId);
      if (!branch) return JSON.stringify({ error: 'No such branch.' });
      await db.saveBranch({ ...branch, acceptance: plan, updatedAt: new Date().toISOString() });
      return JSON.stringify({ acceptance: plan });
    }

    if (call.name === 'list_projects') {
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
        ...(isWorkspaceLanguage(await db.getWorkspaceImages(userId), args.language)
          ? { language: args.language }
          : {}),
      });
      let attachedTo: string | undefined;
      const branch = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === userId);
      if (branch?.treeId) {
        const tree = (await db.getTrees()).find((t) => t.id === branch.treeId && t.ownerId === userId);
        if (tree) {
          await db.saveTree(withProject(tree, project.id));
          attachedTo = tree.name;
        }
      }

      return JSON.stringify({
        created: {
          id: project.id, name: project.name, repo: `${project.giteaOwner}/${project.giteaRepo}`,
          language: project.language ?? DEFAULT_WORKSPACE_LANGUAGE,
        },
        ...(attachedTo
          ? { note: `Leaves on this branch will use this repository by default — no need to set it per leaf.` }
          : {}),
      });
    }

    if (call.name === 'set_leaf_project') {
      const leaf = leaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'No leaf with that id on this branch.' });
      const project = (await projects.listForOwner(userId))
        .find((p) => p.id === String(args.projectId ?? ''));
      if (!project) return JSON.stringify({ error: 'No project with that id.' });
      if (leaf.status !== 'proposed' && leaf.status !== 'pending') {
        return JSON.stringify({ error: `That leaf is already ${leaf.status}; its sandbox exists and cannot be repointed.` });
      }
      await db.saveLeaf({ ...leaf, projectId: project.id, updatedAt: new Date().toISOString() });

      let adopted = false;
      const branchOf = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === userId);
      if (branchOf?.treeId) {
        const tree = (await db.getTrees()).find((t) => t.id === branchOf.treeId && t.ownerId === userId);
        if (tree && !(tree.projectIds ?? []).length) {
          await db.saveTree(withProject(tree, project.id));
          adopted = true;
        }
      }

      return JSON.stringify({
        updated: { id: leaf.id, projectId: project.id, repo: `${project.giteaOwner}/${project.giteaRepo}` },
        ...(adopted
          ? { note: 'Other leaves on this branch will use this repository too, unless pointed elsewhere.' }
          : {}),
      });
    }

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
        ...(isWorkspaceLanguage(await db.getWorkspaceImages(userId), args.language)
          ? { language: args.language }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      await db.saveLeaf(replacement);

      const moved = rewireDependents(leaves, old.id, replacement.id);
      for (const l of moved) await db.saveLeaf({ ...l, updatedAt: now });
      await db.deleteLeaf(old.id);

      return JSON.stringify({
        replaced: { was: old.title, now: replacement.title, id: replacement.id },
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
        const doomed = [leaf, ...childrenOf(leaves, leaf.id)];
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
      const wantedPersona = typeof args.persona === 'string' ? args.persona.trim() : '';
      const mine = withBuiltIns(await db.getPersonas(), userId, (p) => p.name);
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
        ...(persona ? { packId: persona.id } : {}),
        updatedAt: new Date().toISOString(),
      };
      await db.saveLeaf(updated);
      return JSON.stringify({
        revised: { id: updated.id, title: updated.title, ...(persona ? { persona: persona.name } : {}) },
      });
    }

    if (call.name === 'add_project_dependency') {
      return JSON.stringify(await declareDependency(db, userId, args));
    }

    if (call.name === 'list_infrastructure') {
      const infra = describeInfrastructure(await db.getDeployments(), userId, await db.getAppSpecs());
      return JSON.stringify({
        running: infra.running,
        ...(infra.broken.length ? { broken: infra.broken } : {}),
        deployable: infra.deployable,
        note: 'Anything not in `running` and not in `deployable` does not exist here and cannot be '
          + 'built — say so rather than planning around it. A service this project depends on is '
          + 'provided as a binding at deploy time, so a leaf reads its address and credentials from '
          + '$SERVICE_BINDING_ROOT at runtime rather than being given them now.',
      });
    }

    if (call.name === 'list_mcp_servers') {
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
      let mine: { id: string; name: string }[] = [];
      try { mine = (await projects.listForOwner(userId)) as any[]; } catch { mine = []; }
      const editable = servers.filter((s) => s.projectId);
      return JSON.stringify({
        servers: servers.map((s) => ({
          name: s.name,
          status: s.unreachable ? 'unreachable' : 'running',
          ...(s.unreachable ? { unreachable: s.unreachable } : {}),
          tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })),
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
      return JSON.stringify(renderSearchOutcome(query, await webSearch(query)));
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
