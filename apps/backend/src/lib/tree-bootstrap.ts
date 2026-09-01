import { v4 as uuidv4 } from 'uuid';
import type { Database } from './db-interface.js';
import type { Tree } from './trees.js';
import { withProject, normaliseTreeInput } from './trees.js';
import { resolveTreeType } from './tree-types.js';
import { buildPlanningBrief } from './planning-brief.js';
import type { Branch } from './leaves.js';
import type { ProposedTree } from './conversations.js';
import type { ProjectMetadata } from './types.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import { DEFAULT_TARGET_CLUSTER } from './project-shipping.js';

export interface TreeBootstrapDeps {
  db: Database;
  projectRepoService?: Pick<ProjectRepoService, 'register' | 'ensureShippable'> | undefined;
  temporalBridge?: Pick<TemporalBridge, 'planProject'> | undefined;
  nodeIp?: string | undefined;
  port?: string | number | undefined;
  jwtSecret?: string | undefined;
}

export interface TreeBootstrapArgs {
  userId: string;
  proposal: ProposedTree;
}

export interface TreeBootstrapResult {
  tree: Tree;
  branch: Branch;
  project?: ProjectMetadata | undefined;
  /** The planning workflow, when Temporal is reachable. Nothing is executed by accepting. */
  planWorkflowId?: string | undefined;
}

export async function bootstrapAcceptedTree(
  deps: TreeBootstrapDeps,
  args: TreeBootstrapArgs,
): Promise<TreeBootstrapResult> {
  const { db, projectRepoService, temporalBridge } = deps;
  const { userId, proposal } = args;
  const now = new Date().toISOString();

  let tree: Tree = {
    ...normaliseTreeInput({
      name: proposal.name,
      type: proposal.type,
      goal: proposal.goal,
      ...(proposal.brief ? { brief: proposal.brief } : {}),
      ...(proposal.context ? { context: proposal.context } : {}),
      ...(proposal.openQuestions ? { openQuestions: proposal.openQuestions } : {}),
    }),
    ...(proposal.conversationId ? { conversationId: proposal.conversationId } : {}),
    id: uuidv4(),
    ownerId: userId,
    createdAt: now,
    updatedAt: now,
  } as Tree;

  let project: ProjectMetadata | undefined;

  if (projectRepoService) {
    try {
      project = await projectRepoService.register(userId, proposal.name, {
        description: proposal.goal || `Autonomous project: ${proposal.name}`,
      });
      if (project) {
        tree = withProject(tree, project.id);
        if (deps.nodeIp && deps.jwtSecret) {
          try {
            const wired = await projectRepoService.ensureShippable(
              project,
              deps.nodeIp,
              deps.port || 3001,
              deps.jwtSecret,
            );
            project = wired.project;
          } catch (err: any) {
            console.warn(`[tree-bootstrap] could not wire shippable project: ${err?.message}`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[tree-bootstrap] could not register project repo: ${err?.message}`);
    }
  }

  await db.saveTree(tree);

  const treeType = await resolveTreeType(db, userId, tree.type).catch(() => undefined);

  const branchId = uuidv4();
  const branch: Branch = {
    id: branchId,
    treeId: tree.id,
    ownerId: userId,
    title: tree.name,
    // The opening message is the brief the planner will answer, built from the tree's own fields.
    // It used to be a literal here, which is why nothing Koala learned ever reached the planner.
    messages: [{ role: 'user', content: buildPlanningBrief(tree, treeType) }],
    createdAt: now,
    updatedAt: now,
  };
  await db.saveBranch(branch);

  /**
   * No leaf is created here, and nothing is executed.
   *
   * This used to create a "Frame architecture and task breakdown" leaf assigned by matching the
   * persona named 'Framer', carrying the tree type's `validationRecipe` as its own acceptance
   * contract, and start it immediately. Three things were wrong with that: the leaf ran in a
   * sandbox, whose agent loop can only dispatch `sandbox`-surface tools, so it could not call
   * `propose_leaf` and never produced a plan; the validation contract told it to make the product
   * build, which is why it tried to; and the persona was chosen by a display name anyone can edit.
   *
   * Planning is now a planning turn, which proposes leaves for a human to accept.
   */
  let planWorkflowId: string | undefined;
  if (temporalBridge) {
    try {
      planWorkflowId = await temporalBridge.planProject(tree.id, branch.id);
    } catch (err: any) {
      console.warn(`[tree-bootstrap] could not start planning workflow: ${err?.message}`);
    }
  }

  return { tree, branch, project, ...(planWorkflowId ? { planWorkflowId } : {}) };
}
