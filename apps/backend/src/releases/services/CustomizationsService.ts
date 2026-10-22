import { v4 as uuidv4 } from 'uuid';
import { releaseTargetOf } from '../lib/odoo-release.js';
import type { ClusterMetadata, ProjectMetadata } from '../../platform/index.js';
import type { ReleaseHow, ReleaseTarget } from '../lib/release-run.js';
import type { InventoryItem } from '../lib/release-compare.js';
import type { ExportResult } from '../lib/customizations.js';
import type { Tree } from '../../projects/lib/trees.js';
import type { Branch, Leaf } from '../../projects/lib/leaves.js';
import type { Task } from '../../engine-host/tools/tasks.js';
import type { PlanProposal } from '../../projects/lib/plan-proposals.js';
import { parseNewStories } from '../../projects/lib/item-changes.js';
import { parsePlan } from '../../projects/lib/plan-proposals.js';
import { ADOPT_FEATURE, adoptionStory, parseRef } from '../lib/app-drift.js';
import { adapterOf, type SlotAdapter, type SlotAdapters } from '../../extensions/releases/adapter.js';
import type { SlotCluster } from '../../extensions/releases/slot-cluster.js';

export type CustomizationsOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

export interface Drift {
  projectId: string;
  project: string;
  module: string;
  items: InventoryItem[];
}

export interface CustomizationsDeps {
  projects(): Promise<ProjectMetadata[]>;
  clusterById(id: string): Promise<ClusterMetadata | undefined>;
  how(project: ProjectMetadata): Promise<ReleaseHow | undefined>;
  cluster: SlotCluster;
  adapters: SlotAdapters;
  trees(): Promise<Tree[]>;
  branches(): Promise<Branch[]>;
  leaves(): Promise<Leaf[]>;
  tasks(ownerId: string): Promise<Task[]>;
  savePlan(proposal: PlanProposal): Promise<void>;
  treeTypeOf(project: ProjectMetadata): Promise<string>;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

interface Place {
  project: ProjectMetadata;
  target: ReleaseTarget;
  adapter: SlotAdapter;
  module: string;
}

export class CustomizationsService {
  constructor(private readonly deps: CustomizationsDeps) {}

  private async place(ownerId: string, projectId: string): Promise<CustomizationsOutcome<Place>> {
    const project = (await this.deps.projects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
    if (!project) return { ok: false, status: 404, error: 'You have no project with that id' };
    if (!project.targetClusterId) return { ok: false, status: 409, error: `${project.name} has no cluster, so it has no live app` };
    const cluster = await this.deps.clusterById(project.targetClusterId);
    if (!cluster) return { ok: false, status: 409, error: `${project.name}'s cluster is gone` };
    const how = await this.deps.how(project);
    const adapter = (() => { try { return adapterOf(this.deps.adapters, how?.app); } catch { return undefined; } })();
    if (!adapter?.inventory || !adapter.exportItems || !adapter.customizationsModule) {
      return { ok: false, status: 409, error: `${project.name} is not released with an app that can say what was made in it` };
    }
    const target = releaseTargetOf(cluster, project);
    return { ok: true, value: { project, target, adapter, module: adapter.customizationsModule(target) } };
  }

  private async live(place: Place) {
    const state = await this.deps.cluster.state(place.target);
    return state.installed && state.tags[state.live] ? state.live : undefined;
  }

  async drift(ownerId: string, projectId: string): Promise<CustomizationsOutcome<Drift>> {
    const placed = await this.place(ownerId, projectId);
    if (!placed.ok) return placed;
    const { project, target, adapter, module } = placed.value;
    const slot = await this.live(placed.value);
    if (!slot) return { ok: true, value: { projectId, project: project.name, module, items: [] } };
    return { ok: true, value: { projectId, project: project.name, module, items: await adapter.inventory!(this.deps.cluster, target, slot) } };
  }

  async propose(ownerId: string, projectId: string, body: unknown, from: { conversationId?: string | undefined; runId?: string | undefined }): Promise<CustomizationsOutcome<PlanProposal>> {
    const { refs, why } = (body ?? {}) as { refs?: unknown; why?: unknown };
    if (typeof why !== 'string' || !why.trim()) return { ok: false, status: 400, error: 'say why, for the card' };
    if (refs !== undefined && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string'))) return { ok: false, status: 400, error: 'refs is a list of item refs, as app_drift lists them' };
    const drift = await this.drift(ownerId, projectId);
    if (!drift.ok) return drift;
    const wanted = refs === undefined ? undefined : new Set(refs as string[]);
    const items = drift.value.items.filter((item) => !wanted || wanted.has(`${item.kind}/${item.key}`));
    if (wanted) {
      const known = new Set(drift.value.items.map((item) => `${item.kind}/${item.key}`));
      const unknown = [...wanted].filter((ref) => !known.has(ref));
      if (unknown.length) return { ok: false, status: 400, error: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not among what the live app holds outside git` };
    }
    if (!items.length) return { ok: false, status: 409, error: `${drift.value.project}'s live app holds nothing outside git to bring in` };

    const at = this.deps.now?.() ?? new Date().toISOString();
    const card = (body: Pick<PlanProposal, 'plan' | 'change'>): PlanProposal => ({
      id: (this.deps.newId ?? uuidv4)(),
      ownerId,
      projectId,
      status: 'proposed',
      ...body,
      ...(from.conversationId ? { conversationId: from.conversationId } : {}),
      ...(from.runId ? { runId: from.runId } : {}),
      createdAt: at,
      updatedAt: at,
    } as PlanProposal);
    const story = adoptionStory(items, drift.value.module);

    const tree = (await this.deps.trees()).find((entry) => entry.ownerId === ownerId && (entry.projectIds ?? []).includes(projectId));
    if (!tree) {
      const project = (await this.deps.projects()).find((entry) => entry.id === projectId)!;
      const type = await this.deps.treeTypeOf(project);
      const planned = parsePlan({
        tree: { name: project.name, type, goal: `${project.name} keeps what was made in its live app` },
        planDoc: [
          `# ${project.name}`,
          '## Destination',
          `What was made or changed in ${project.name}'s live app is in git, in addons/${drift.value.module}, and every release keeps it.`,
          '## Not yet specified',
          'None',
          '## Out of scope',
          'Changing what was made in the app: it is brought in exactly as it is.',
        ].join('\n\n'),
        branches: [{ title: ADOPT_FEATURE, leaves: [story] }],
      }, { treeTypes: [type], existingLeafIds: new Set(), ownerId });
      if ('problem' in planned) return { ok: false, status: 400, error: planned.problem };
      const proposal = card({ plan: planned.plan });
      await this.deps.savePlan(proposal);
      return { ok: true, value: proposal };
    }
    const branches = (await this.deps.branches()).filter((branch) => branch.treeId === tree.id);
    const existing = branches.find((branch) => branch.title === ADOPT_FEATURE);
    const branch = existing ?? { id: `${tree.id}-customizations`, title: ADOPT_FEATURE };
    const branchIds = new Set(branches.map((entry) => entry.id));
    const leaves = (await this.deps.leaves()).filter((leaf) => branchIds.has(leaf.branchId));
    const parsed = parseNewStories({ why, stories: [story] }, branch, { treeId: tree.id, leaves, tasks: await this.deps.tasks(ownerId) });
    if ('problem' in parsed) return { ok: false, status: 400, error: parsed.problem };
    const proposal = card({ change: { ...parsed.change, add: { ...parsed.change.add!, ...(existing ? {} : { newBranch: true }) } } });
    await this.deps.savePlan(proposal);
    return { ok: true, value: proposal };
  }

  async exportItems(ownerId: string, projectId: string, refs: readonly string[]): Promise<CustomizationsOutcome<ExportResult>> {
    const placed = await this.place(ownerId, projectId);
    if (!placed.ok) return placed;
    const items = refs.map((ref) => ({ ref, parsed: parseRef(ref) }));
    const bad = items.filter((item) => !item.parsed).map((item) => item.ref);
    if (bad.length || !items.length) return { ok: false, status: 400, error: bad.length ? `${bad.join(', ')} ${bad.length === 1 ? 'is not a ref' : 'are not refs'}; app_drift lists them` : 'name the refs to export' };
    const slot = await this.live(placed.value);
    if (!slot) return { ok: false, status: 409, error: `${placed.value.project.name} has nothing live to export from` };
    const { target, adapter, module } = placed.value;
    return { ok: true, value: await adapter.exportItems!(this.deps.cluster, target, slot, items.map((item) => item.parsed!), module) };
  }
}
