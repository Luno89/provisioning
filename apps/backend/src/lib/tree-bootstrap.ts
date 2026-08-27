/**
 * tree-bootstrap — activating a project tree when accepted from Koala chat or the UI.
 *
 * ── WHAT HAPPENED BEFORE ──
 * When a user clicked "Accept to Grove" on a Koala proposal, the backend created an empty Tree
 * record in MongoDB and stopped. Koala could not continue autonomously, no repository was seeded,
 * no branch was opened, and no initial persona workflow was triggered.
 *
 * ── WHAT THIS DOES ──
 * 1. Creates/ensures a shippable project repository (Gitea webhook + target cluster + autoDeploy).
 * 2. Links the project repository to the Tree record.
 * 3. Creates the root Branch for the Tree with the initial goal.
 * 4. Creates the root Framer/Planner leaf and queues it for execution.
 * 5. If TemporalBridge is available, starts the leaf workflow immediately.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Database } from './db-interface.js';
import type { Tree } from './trees.js';
import { withProject, normaliseTreeInput } from './trees.js';
import type { Branch, Leaf } from './leaves.js';
import type { ProposedTree } from './conversations.js';
import type { ProjectMetadata } from './types.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import { DEFAULT_TARGET_CLUSTER } from './project-shipping.js';

export interface TreeBootstrapDeps {
  db: Database;
  projectRepoService?: Pick<ProjectRepoService, 'register' | 'ensureShippable'> | undefined;
  temporalBridge?: Pick<TemporalBridge, 'startLeaf'> | undefined;
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
  leaf: Leaf;
  project?: ProjectMetadata | undefined;
}

export async function bootstrapAcceptedTree(
  deps: TreeBootstrapDeps,
  args: TreeBootstrapArgs,
): Promise<TreeBootstrapResult> {
  const { db, projectRepoService, temporalBridge } = deps;
  const { userId, proposal } = args;
  const now = new Date().toISOString();

  let tree: Tree = {
    ...normaliseTreeInput({ name: proposal.name, type: proposal.type, goal: proposal.goal }),
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

  const branchId = uuidv4();
  const branch: Branch = {
    id: branchId,
    treeId: tree.id,
    ownerId: userId,
    title: tree.name,
    messages: [
      {
        role: 'user',
        content: proposal.goal
          ? `Goal: ${proposal.goal}\n\nDecompose this project into actionable architecture and implementation tasks.`
          : `Decompose ${proposal.name} into architecture and implementation tasks.`,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await db.saveBranch(branch);

  const personas = await db.getPersonas().catch(() => []);
  const framer = personas.find((p) => p.ownerId === userId && p.name === 'Framer')
    || personas.find((p) => p.name === 'Framer');

  const availableTypes = await db.getTreeTypes(userId).catch(() => []);
  const treeType = availableTypes.find((t) => t.id === tree.type);

  const leafId = uuidv4();
  const leaf: Leaf = {
    id: leafId,
    branchId: branch.id,
    ownerId: userId,
    title: `Frame architecture and task breakdown for ${proposal.name}`,
    body: proposal.goal || `Architecture and task breakdown for ${proposal.name}`,
    column: 'todo',
    status: 'pending',
    depth: 0,
    blocking: false,
    ...(framer?.id ? { personaId: framer.id } : {}),
    ...(project?.id ? { projectId: project.id } : {}),
    ...(treeType?.validationRecipe ? { validationContract: treeType.validationRecipe } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await db.saveLeaf(leaf);

  if (temporalBridge) {
    try {
      await temporalBridge.startLeaf(leaf);
    } catch (err: any) {
      console.warn(`[tree-bootstrap] could not start leaf workflow: ${err?.message}`);
    }
  }

  return { tree, branch, leaf, project };
}
