import { v4 as uuidv4 } from 'uuid';
import { resolvePersonaNamed } from './proposal-merge.js';
import {
  canAddChild, childrenOf, wouldCycle, resolveDependencyTitles, dependentsOf, subtreeOf, type Leaf,
} from './leaves.js';
import { usablePaths } from './leaf-artifacts.js';
import { normaliseLeafInput } from './leaf-input.js';
import { usableAcceptancePlan } from './acceptance.js';
import { hollowChecks, explainHollow } from './acceptance-validation.js';
import { rewireDependents } from './plan-review.js';
import { withProject } from './trees.js';
import { summariseLeaf, detailLeaf } from './leaf-tools.js';
import { DEFAULT_WORKSPACE_LANGUAGE } from './workspace-spec.js';
import { isWorkspaceLanguage } from './workspace-image-catalogue.js';
import { withBuiltIns } from './ownership.js';
import type { ToolRuntime } from './tool-runtime.js';

/**
 * Tools that write to one branch, and so must be able to name which.
 *
 * `create_project` is deliberately absent: it attaches the new repository to a tree when there is
 * one, and works perfectly well when there is not.
 */
const NEEDS_BRANCH = new Set([
  'propose_leaf', 'revise_leaf', 'withdraw_leaf', 'replace_leaf', 'delete_leaf',
  'set_acceptance', 'set_leaf_project', 'write_plan_document',
]);

/**
 * The planning tools, dispatched by name.
 *
 * Reads and id lookups run over everything the owner has; only the relationship logic -- parents,
 * children, dependency titles, cycles -- is branch-scoped, because only it is meaningful within
 * one branch. Scoping the WHOLE toolset to one branch is what made `list_leaves` unusable from
 * anywhere without an ambient branch, chat included.
 */
export async function runPlanningTool(
  rt: ToolRuntime,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { db, userId, ingest, mcpRegistry } = rt;
  const projects = rt.projects!;

  const ownedLeaves = (await db.getLeaves()).filter((l) => l.ownerId === userId);
  const ownedBranches = (await db.getBranches()).filter((b) => b.ownerId === userId);

  // Which branch a write attaches to. An explicit argument wins; failing that, the branch of the
  // leaf being changed; failing that, the branch the caller already works in. A chat turn has only
  // the first two, which is why they exist.
  const asked = typeof args.branchId === 'string' && args.branchId.trim()
    ? { kind: 'branchId' as const, value: args.branchId.trim() }
    : typeof args.treeId === 'string' && args.treeId.trim()
      ? { kind: 'treeId' as const, value: args.treeId.trim() }
      : undefined;
  const fromArgs = asked
    ? (asked.kind === 'branchId'
        ? ownedBranches.find((b) => b.id === asked.value)?.id
        : ownedBranches.find((b) => b.treeId === asked.value)?.id)
    : undefined;
  const fromLeaf = ownedLeaves.find((l) => l.id === String(args.id ?? ''))?.branchId;
  const branchId = fromArgs ?? fromLeaf ?? rt.branchId;
  const leaves = ownedLeaves.filter((l) => l.branchId === branchId);

  if (asked && !fromArgs) {
    return JSON.stringify({ error: `You have no ${asked.kind} "${asked.value}".` });
  }
  if (NEEDS_BRANCH.has(name) && !branchId) {
    return JSON.stringify({
      error: `${name} works on one branch, and this run is not in one. Pass treeId (or branchId), `
        + 'or name an existing leaf in id. list_leaves reports both for every leaf you have.',
    });
  }

  try {
    if (name === 'list_leaves') {
      const status = typeof args.status === 'string' ? args.status : undefined;
      // An explicit treeId/branchId narrows, and an ambient branch is a default. With neither,
      // every leaf the owner has -- which is what "list my leaves" means asked from a chat.
      const scoped = asked || rt.branchId
        ? ownedLeaves.filter((l) => l.branchId === branchId)
        : ownedLeaves;
      const filtered = status ? scoped.filter((l) => l.status === status) : scoped;
      const trees = (await db.getTrees()).filter((t) => t.ownerId === userId);
      // Which tree and branch each leaf is on, so a list spanning several is still readable.
      const where = (leaf: Leaf) => {
        const branch = ownedBranches.find((b) => b.id === leaf.branchId);
        const tree = branch?.treeId ? trees.find((t) => t.id === branch.treeId) : undefined;
        return { branchId: leaf.branchId, ...(tree ? { treeId: tree.id, tree: tree.name } : {}) };
      };
      return JSON.stringify({ leaves: filtered.map((l) => ({ ...summariseLeaf(l), ...where(l) })) });
    }

    if (name === 'get_leaf') {
      // By id across everything the owner has: leaf ids are uuids, so no branch is needed to
      // find one. Its children still come from its own branch, which is where they live.
      const leaf = ownedLeaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'You have no leaf with that id.' });
      const siblings = ownedLeaves.filter((l) => l.branchId === leaf.branchId);
      return JSON.stringify(detailLeaf(leaf, childrenOf(siblings, leaf.id), siblings));
    }

    if (name === 'start_ingest' || name === 'ingest_status' || name === 'search_corpus') {
      if (!ingest) {
        return JSON.stringify({ error: 'Ingestion is not available here.' });
      }

      if (name === 'start_ingest') {
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

      if (name === 'ingest_status') {
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

    if (name === 'list_personas') {
      const mine = withBuiltIns(await db.getPersonaPacks(), userId, (p) => p.slug);
      return JSON.stringify({
        personas: mine.map((p) => ({ name: p.name, description: p.description ?? '' })),
      });
    }

    if (name === 'write_plan_document') {
      const content = typeof args.content === 'string' ? args.content.trim() : '';
      if (!content) return JSON.stringify({ error: 'content is required — the document itself.' });

      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : 'PLAN.md';
      const path = rawPath.replace(/^\/+/, '');
      if (!path || path.split('/').includes('..')) {
        return JSON.stringify({ error: 'path must be relative and stay inside the repository.' });
      }

      const branch = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === userId);
      const tree = branch?.treeId
        ? (await db.getTrees()).find((t) => t.id === branch.treeId && t.ownerId === userId)
        : undefined;
      const projectId = tree?.projectIds?.[0];
      if (!projectId) {
        return JSON.stringify({
          error: 'This project has no repository yet. Call create_project first, then write the plan.',
        });
      }
      const project = (await projects.listForOwner(userId)).find((p) => p.id === projectId);
      if (!project) return JSON.stringify({ error: 'The project repository is no longer available.' });

      try {
        const written = await projects.writeDocument(
          project, path, content, `Plan: ${tree?.name ?? 'project'}`,
        );
        return JSON.stringify(written
          ? { written: path, repo: `${project.giteaOwner}/${project.giteaRepo}` }
          : { error: `${path} already exists in the repository; nothing was overwritten.` });
      } catch (err) {
        return JSON.stringify({ error: `Could not commit ${path}: ${(err as Error).message}` });
      }
    }

    if (name === 'propose_leaf') {
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

      const myPacks = (await db.getPersonaPacks()).filter((p) => p.ownerId == null || p.ownerId === userId);
      const wantedPersona = typeof args.persona === 'string' ? args.persona.trim() : '';
      const persona = resolvePersonaNamed(wantedPersona, myPacks);

      const wantedProjectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      // Lazy on purpose, same as before — a leaf naming no project at all should never need
      // `projects` to be callable (leaf-execution-only runtimes don't wire it).
      const myProjects = wantedProjectId ? await projects.listForOwner(userId) : [];
      const wantedProject = wantedProjectId
        ? myProjects.find((p) => p.id === wantedProjectId)
        : undefined;
      // Was a server-only console.warn — the model got no signal its projectId didn't match
      // anything and would repeat the same wrong id on every later leaf, silently.
      const projectWarning = wantedProjectId && !wantedProject
        ? `No project has id "${args.projectId}", so this leaf has no repository. Call list_projects `
          + 'and use one of those ids, or create_project first if none fits.'
        : undefined;

      const now = new Date().toISOString();
      const leaf: Leaf = {
        id,
        ownerId: userId,
        branchId: branchId!,
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
              // The same table `persona` was actually matched against — was `db.getPersonas()`,
              // a different collection than what this checks, so a name copied from this hint
              // could look right and still fail to match on the next call.
              availablePersonas: myPacks.map((p) => ({ name: p.name, description: p.description ?? '' })),
            }
          : { persona: persona!.name }),
        ...(projectWarning
          ? {
              projectWarning,
              availableProjects: myProjects.map((p) => ({ id: p.id, name: p.name })),
            }
          : wantedProject ? { project: wantedProject.name } : {}),
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

    if (name === 'set_acceptance') {
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

    if (name === 'list_projects') {
      const mine = await projects.listForOwner(userId);
      return JSON.stringify({
        projects: mine.map((p) => ({ id: p.id, name: p.name, repo: `${p.giteaOwner}/${p.giteaRepo}` })),
      });
    }

    if (name === 'create_project') {
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

    if (name === 'set_leaf_project') {
      const leaf = ownedLeaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'You have no leaf with that id.' });
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

    if (name === 'replace_leaf') {
      const old = ownedLeaves.find((l) => l.id === String(args.id ?? ''));
      if (!old) return JSON.stringify({ error: 'You have no leaf with that id.' });
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

    if (name === 'withdraw_leaf') {
      const leaf = ownedLeaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'You have no leaf with that id.' });
      if (leaf.status !== 'proposed') {
        return JSON.stringify({
          error: `That leaf is already ${leaf.status}, so it is no longer yours to change. Call delete_leaf instead, or let the user decide.`,
        });
      }

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

    if (name === 'delete_leaf') {
      const leaf = ownedLeaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'You have no leaf with that id.' });

      const doomed = [leaf, ...subtreeOf(leaves, leaf.id)];
      const blocking = doomed.find((d) => d.status === 'succeeded');
      if (blocking) {
        return JSON.stringify({
          error: `"${blocking.title}" already succeeded${blocking.id !== leaf.id ? ' (a sub-leaf of this one)' : ''} — `
            + 'that is real completed work, and removing it is the human\'s call, not this tool\'s. '
            + 'Ask them, or leave it and delete only what did not succeed.',
        });
      }

      for (const d of doomed) {
        await rt.temporalBridge?.signalLeaf(d.id, 'cancelLeaf');
        await db.deleteLeaf(d.id);
        await db.deleteLeafTrace(d.id);
      }
      const orphaned = doomed.flatMap((d) => dependentsOf(d.id, leaves))
        .filter((l) => !doomed.some((d) => d.id === l.id));

      return JSON.stringify({
        deleted: { id: leaf.id, title: leaf.title, alsoRemoved: doomed.length - 1 },
        ...(orphaned.length
          ? {
              warning: `${orphaned.map((l) => `"${l.title}"`).join(', ')} depended on this and will now `
                + 'start without waiting for anything. Use revise_leaf to give them a different dependency.',
            }
          : {}),
      });
    }

    if (name === 'revise_leaf') {
      const leaf = ownedLeaves.find((l) => l.id === String(args.id ?? ''));
      if (!leaf) return JSON.stringify({ error: 'You have no leaf with that id.' });
      if (leaf.status !== 'proposed' && leaf.status !== 'pending') {
        return JSON.stringify({
          error: `That leaf is already ${leaf.status}; its sandbox exists and cannot be changed. `
            + 'Call delete_leaf and repropose it if it needs different dependencies now.',
        });
      }

      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const body = typeof args.body === 'string' ? args.body.trim() : '';
      const wantedPersona = typeof args.persona === 'string' ? args.persona.trim() : '';
      // Must be the same table propose_leaf resolves against — Leaf.packId is a PersonaPack id,
      // not a Persona id. This used to resolve against db.getPersonas() and store that id into
      // packId anyway: a name that matched still wrote the wrong kind of id, silently breaking the
      // assignment the model thought it had just fixed.
      const mine = (await db.getPersonaPacks()).filter((p) => p.ownerId == null || p.ownerId === userId);
      const persona = resolvePersonaNamed(wantedPersona, mine);
      if (wantedPersona && !persona) {
        return JSON.stringify({
          error: `No persona is named "${args.persona}".`,
          availablePersonas: mine.map((p) => ({ name: p.name, description: p.description ?? '' })),
        });
      }

      let dependsOn: string[] | undefined;
      let recordedDependsOn: string[] | undefined;
      let dependsOnWarning: string | undefined;
      if (Array.isArray(args.dependsOn)) {
        const wantedDeps = args.dependsOn.map(String);
        const resolved = resolveDependencyTitles(wantedDeps, leaves);
        if (wouldCycle(leaf.id, resolved.ids, leaves)) {
          return JSON.stringify({ error: 'Those dependencies would form a cycle — nothing in it could ever start.' });
        }
        dependsOn = resolved.ids;
        recordedDependsOn = resolved.ids
          .map((depId) => leaves.find((l) => l.id === depId)?.title)
          .filter((t): t is string => Boolean(t));
        if (resolved.unresolved.length) {
          dependsOnWarning = `These matched no leaf and were NOT recorded: ${resolved.unresolved.map((t) => `"${t}"`).join(', ')}.`;
        }
      }

      if (!title && !body && !persona && dependsOn === undefined) {
        return JSON.stringify({ error: 'Nothing to change — pass title, body, persona, dependsOn, or a combination.' });
      }

      let updated: Leaf = {
        ...leaf,
        ...(title ? { title: title.slice(0, 200) } : {}),
        ...(body ? { body: body.slice(0, 4000) } : {}),
        ...(persona ? { packId: persona.id } : {}),
        updatedAt: new Date().toISOString(),
      };
      if (dependsOn !== undefined) {
        if (dependsOn.length) {
          updated = { ...updated, dependsOn };
        } else {
          const { dependsOn: _drop, ...rest } = updated;
          updated = rest as Leaf;
        }
      }
      await db.saveLeaf(updated);
      return JSON.stringify({
        revised: { id: updated.id, title: updated.title, ...(persona ? { persona: persona.name } : {}) },
        ...(dependsOn !== undefined ? { dependsOn: recordedDependsOn } : {}),
        ...(dependsOnWarning ? { warning: dependsOnWarning } : {}),
      });
    }

    if (name === 'list_mcp_servers') {
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
      try { mine = (await rt.projects?.listForOwner(userId) ?? []) as any[]; } catch { mine = []; }
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

    if (name === 'update_leaf_memory') {
      const category = String(args.category ?? 'lessons_learned');
      const title = String(args.title ?? '');
      const text = String(args.text ?? '');
      return JSON.stringify({ savedMemory: { category, title, text, timestamp: new Date().toISOString() } });
    }

    return JSON.stringify({ error: `${name} is not one of the planning tools.` });
  } catch (err: any) {
    return JSON.stringify({ error: String(err?.message ?? err).slice(0, 300) });
  }
}
