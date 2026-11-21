import type { Database } from '../platform/index.js';
import { treeOutline } from '../projects/lib/tree-outline.js';
import { featureOutline, storyOutline } from '../projects/lib/item-outline.js';
import { projectOutline } from '../projects/lib/project-outline.js';
import { chatFraming, SOMEONE } from '../engine/lib/conversations.js';

type BindingSources = Pick<Database, 'engine' | 'projects' | 'releases' | 'accounts'>;

export function conversationBinding(db: BindingSources) {
  const statusOf = async (ownerId: string, projectIds: readonly string[]): Promise<string> => {
    const wanted = new Set(projectIds);
    const projects = (await db.projects.getProjects()).filter((project) => project.ownerId === ownerId && wanted.has(project.id));
    if (projects.length === 0) return '';
    const runs = await db.releases.getPipelineRuns();
    const statuses = await Promise.all(projects.map(async (project) =>
      projectOutline(project, await db.releases.getOdooReleases(ownerId, project.id), runs.filter((run) => run.projectId === project.id))));
    return statuses.join('\n\n');
  };

  const subjectOf = async (ownerId: string, conversation: Awaited<ReturnType<BindingSources['engine']['getConversation']>>): Promise<Record<string, string> | undefined> => {
    if (conversation?.leafId || conversation?.branchId) {
      const leaves = await db.projects.getLeaves();
      const leaf = conversation.leafId ? leaves.find((candidate) => candidate.id === conversation.leafId && candidate.ownerId === ownerId) : undefined;
      const branchId = leaf?.branchId ?? conversation.branchId;
      const branch = (await db.projects.getBranches()).find((candidate) => candidate.id === branchId && candidate.ownerId === ownerId);
      const tree = branch ? (await db.projects.getTrees()).find((candidate) => candidate.id === branch.treeId && candidate.ownerId === ownerId) : undefined;
      if (!branch || !tree || (conversation.leafId && !leaf)) return undefined;
      if (leaf) {
        const tasks = (await db.projects.getTasks(ownerId)).filter((task) => task.leafId === leaf.id);
        const project = await statusOf(ownerId, tree.projectIds ?? []);
        return { treeId: tree.id, leafId: leaf.id, story: storyOutline(leaf, { tree, branch }, leaves, tasks), ...(project ? { project } : {}) };
      }
      const project = await statusOf(ownerId, tree.projectIds ?? []);
      return { treeId: tree.id, branchId: branch.id, feature: featureOutline(branch, tree, leaves), ...(project ? { project } : {}) };
    }
    if (conversation?.treeId) {
      const tree = (await db.projects.getTrees()).find((candidate) => candidate.id === conversation.treeId && candidate.ownerId === ownerId);
      if (!tree) return undefined;
      const branches = (await db.projects.getBranches()).filter((branch) => branch.treeId === tree.id);
      const branchIds = new Set(branches.map((branch) => branch.id));
      const leaves = (await db.projects.getLeaves()).filter((leaf) => branchIds.has(leaf.branchId));
      const leafIds = new Set(leaves.map((leaf) => leaf.id));
      const tasks = (await db.projects.getTasks(ownerId)).filter((task) => task.leafId && leafIds.has(task.leafId));
      const project = await statusOf(ownerId, [...new Set([...(conversation.projectId ? [conversation.projectId] : []), ...(tree.projectIds ?? [])])]);
      return { treeId: tree.id, tree: treeOutline(tree, branches, leaves, tasks), ...(project ? { project } : {}) };
    }
    if (conversation?.projectId) {
      const project = (await db.projects.getProjects()).find((candidate) => candidate.id === conversation.projectId && candidate.ownerId === ownerId);
      if (!project) return undefined;
      return {
        projectId: project.id,
        project: `${await statusOf(ownerId, [project.id])}\nIt has no Grove tree yet: a new tree planned in this conversation is linked to it when the person approves the plan.`,
      };
    }
    return undefined;
  };

  return async (ownerId: string, conversationId: string): Promise<Record<string, string> | undefined> => {
    const conversation = await db.engine.getConversation(ownerId, conversationId);
    const subject = await subjectOf(ownerId, conversation);
    if (!subject || !conversation?.kind) return subject;
    const who = (await db.accounts.getUserById(ownerId))?.email ?? SOMEONE;
    const chat = chatFraming({ kind: conversation.kind, item: conversation.leafId ? 'story' : conversation.branchId ? 'feature' : undefined }, who);
    return chat ? { chat, ...subject } : subject;
  };
}
