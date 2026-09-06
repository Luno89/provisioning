import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import type { ProjectMetadata } from './types.js';
import type { Tree } from './trees.js';
import type { TreeTypeSpec } from './tree-types.js';
import { resolveLeafProject } from './leaf-project.js';
import { renderStarterFiles } from './tree-types.js';
import { primaryProjectId, withProject } from './trees.js';
import { nodeBaseImage } from './project-templates.js';
import { resolveBindings, type BindingRequest, type ResolvedBinding } from './binding-resolve.js';
import { visibleAppSpecs } from './app-spec.js';

export interface GiteaAccess {
  internalBaseUrl: string;
  getRepo(username: string, name: string): Promise<unknown>;
  createRepoForUser(username: string, name: string, opts: { description: string }): Promise<unknown>;
  seedTemplate(owner: string, repo: string, files: { path: string; content: string }[]): Promise<string[]>;
}

export interface ProjectReposAccess {
  ensureAccountFor(ownerId: string): Promise<{ username: string }>;
  checkoutCredential(ownerId: string, project: ProjectMetadata): Promise<{ cloneUrl: string; tokenName: string; username: string }>;
  ensureShippable(project: ProjectMetadata, nodeIp: string, port: string | number, jwtSecret: string): Promise<{ problems: string[] }>;
}

export interface InfraAccess {
  runKubectl(args: string[], kubeconfigPath: string): Promise<string>;
}

export interface ResolveLeafRepoDeps {
  db: Pick<Database, 'getProjects' | 'saveProject' | 'getTrees' | 'saveTree'>;
  gitea: GiteaAccess;
  infra: InfraAccess;
  projectRepos: ProjectReposAccess;
  newId: () => string;
}

export interface LeafRepoResolution {
  project: ProjectMetadata | undefined;
  checkout: { cloneUrl: string; tokenName: string; username: string } | undefined;
  giteaBaseUrl: string;
}

export async function resolveLeafRepo(
  deps: ResolveLeafRepoDeps,
  leaf: Leaf,
  treeOf: Tree | undefined,
  treeType: TreeTypeSpec | undefined,
  producesCode: boolean,
  wantsRepo: boolean,
): Promise<LeafRepoResolution> {
  if (!wantsRepo) {
    console.log(`[leaf-run-environment] leaf ${leaf.id}: persona writes no files, so no checkout`);
    return { project: undefined, checkout: undefined, giteaBaseUrl: '' };
  }

  try {
    const project = await resolveLeafProject({
      db: deps.db,
      ...(treeOf ? { treeProjectId: primaryProjectId(treeOf) } : {}),
      ensureAccount: (ownerId) => deps.projectRepos.ensureAccountFor(ownerId),
      repoExists: (username, name) => deps.gitea.getRepo(username, name).then(() => true, () => false),
      createRepo: (username, name) => deps.gitea.createRepoForUser(username, name, {
        description: `Koala request ${leaf.branchId.slice(0, 8)}`,
      }).then(() => undefined),
      newId: deps.newId,
    }, leaf);

    const giteaBaseUrl = deps.gitea.internalBaseUrl;
    const checkout = await deps.projectRepos.checkoutCredential(leaf.ownerId, project);

    try {
      const files = renderStarterFiles(treeType?.files ?? [], {
        projectName: project.giteaRepo,
        registryHost: nodeBaseImage(),
      });
      if (files.length) {
        const written = await deps.gitea.seedTemplate(project.giteaOwner, project.giteaRepo, files);
        if (written.length) {
          console.log(`[leaf-run-environment] seeded ${project.giteaRepo} from the ${treeType?.label ?? treeOf?.type} template: ${written.join(', ')}`);
        }
      }
    } catch (err) {
      console.warn(`[leaf-run-environment] could not seed ${project.giteaRepo}: ${(err as Error).message}`);
    }

    if (producesCode) {
      try {
        const nodeIp = await deps.infra.runKubectl(
          ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
          '/tmp/kubeconfig-provisioning-lunorica',
        );
        const wired = await deps.projectRepos.ensureShippable(project, nodeIp, process.env.PORT || 3001, process.env.JWT_SECRET ?? '');
        if (wired.problems.length) {
          console.warn(`[leaf-run-environment] leaf ${leaf.id}: project not fully shippable — ${wired.problems.join('; ')}`);
        }
      } catch (err) {
        console.warn(`[leaf-run-environment] leaf ${leaf.id}: could not wire ${project.name} for builds: ${(err as Error).message}`);
      }
    }

    if (treeOf) {
      const fresh = (await deps.db.getTrees()).find((t) => t.id === treeOf.id);
      if (fresh) await deps.db.saveTree(withProject(fresh, project.id));
    }

    return { project, checkout, giteaBaseUrl };
  } catch (err) {
    console.warn(`[leaf-run-environment] no repository for leaf ${leaf.id}, work will not persist: ${(err as Error).message}`);
    return { project: undefined, checkout: undefined, giteaBaseUrl: '' };
  }
}

export interface ResolveLeafBindingsDeps {
  db: Pick<Database, 'getBindingTypes' | 'getDeployments' | 'getAppSpecs'>;
}

export async function resolveLeafBindings(
  deps: ResolveLeafBindingsDeps,
  leafId: string,
  needs: readonly BindingRequest[],
  ownerId: string,
): Promise<{ bindings: ResolvedBinding[] }> {
  if (!needs.length) return { bindings: [] };

  try {
    const dynamicTypes = await deps.db.getBindingTypes().catch(() => []);
    const resolution = resolveBindings(
      needs,
      await deps.db.getDeployments(),
      visibleAppSpecs(await deps.db.getAppSpecs(), ownerId),
      ownerId,
      { dynamicTypes },
    );
    for (const problem of resolution.problems) {
      console.warn(`[leaf-run-environment] ${leafId}: binding not available — ${problem}`);
    }
    return { bindings: resolution.bindings };
  } catch (err) {
    console.warn(`[leaf-run-environment] ${leafId}: could not resolve bindings: ${(err as Error).message}`);
    return { bindings: [] };
  }
}
