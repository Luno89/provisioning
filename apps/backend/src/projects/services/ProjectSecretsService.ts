import { v4 as uuidv4 } from 'uuid';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { Tree } from '../lib/trees.js';
import { primaryProjectId } from '../lib/trees.js';
import { resolveTreeType, type TreeTypeSecret, type TreeTypeSpec } from '../lib/tree-types.js';
import { secretReference, withRequired, type SecretRequest, type SecretRequestFilter } from '../lib/secret-requests.js';
import { createSecretVault, type VaultBackend } from './SecretRequestService.js';
import type { ProjectsStore } from '../store.js';

export interface DeclaredSecretVault {
  has(projectId: string, key: string): Promise<boolean>;
  read(projectId: string, key: string): Promise<string | null>;
  put(projectId: string, key: string, value: string, comment: string): Promise<void>;
  mint(ownerId: string, projectId: string, key: string, sourceId: string): Promise<void>;
}

export interface ProjectSecretsDeps {
  vault: DeclaredSecretVault;
  treeTypes: (ownerId: string) => Promise<TreeTypeSpec[]>;
  trees: () => Promise<Tree[]>;
  requests: {
    list(ownerId: string, filter?: SecretRequestFilter): Promise<SecretRequest[]>;
    save(request: SecretRequest): Promise<void>;
  };
  saveProjectInfo: (project: Partial<ProjectMetadata> & { id: string }) => Promise<ProjectMetadata>;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
  asked?: ((request: SecretRequest) => void) | undefined;
}

export interface EnsuredSecrets {
  declared: TreeTypeSecret[];
  waiting: string[];
}

export interface SignIn {
  login: string;
  password: string;
  describe: string;
}

export class ProjectSecretsService {
  constructor(private readonly deps: ProjectSecretsDeps) {}

  async declared(project: Pick<ProjectMetadata, 'id' | 'ownerId'>, type?: TreeTypeSpec | undefined): Promise<TreeTypeSecret[]> {
    return (await this.home(project, type)).secrets;
  }

  private async home(project: Pick<ProjectMetadata, 'id' | 'ownerId'>, type?: TreeTypeSpec | undefined): Promise<{ secrets: TreeTypeSecret[]; treeId?: string | undefined }> {
    const ownerId = project.ownerId;
    if (!ownerId) return { secrets: [] };
    const tree = (await this.deps.trees()).find((entry) => entry.ownerId === ownerId && primaryProjectId(entry) === project.id);
    if (type) return { secrets: type.secrets ?? [], ...(tree ? { treeId: tree.id } : {}) };
    if (!tree) return { secrets: [] };
    const found = await resolveTreeType({ getTreeTypes: () => this.deps.treeTypes(ownerId) }, ownerId, tree.type);
    return { secrets: found?.secrets ?? [], treeId: tree.id };
  }

  async ensure(
    project: Pick<ProjectMetadata, 'id' | 'ownerId' | 'requiredSecrets'>,
    options: { type?: TreeTypeSpec | undefined; seed?: ((key: string) => Promise<string | undefined>) | undefined; fallback?: readonly TreeTypeSecret[] | undefined } = {},
  ): Promise<EnsuredSecrets> {
    const home = await this.home(project, options.type);
    const declared = home.secrets.length > 0 || home.treeId ? home.secrets : [...(options.fallback ?? [])];
    const { treeId } = home;
    const ownerId = project.ownerId;
    if (declared.length === 0 || !ownerId) return { declared, waiting: [] };
    const waiting: string[] = [];
    let required: { key: string; source: string }[] = project.requiredSecrets ?? [];
    for (const secret of declared) {
      required = withRequired(required, secret.key, secret.source);
      if (await this.deps.vault.has(project.id, secret.key)) continue;
      const seeded = await options.seed?.(secret.key);
      if (seeded) {
        await this.deps.vault.put(project.id, secret.key, seeded, 'Carried over from the running app');
        continue;
      }
      if (secret.source === 'person') {
        await this.ask(ownerId, project.id, secret, treeId);
        waiting.push(secret.key);
        continue;
      }
      await this.deps.vault.mint(ownerId, project.id, secret.key, secret.source);
    }
    await this.deps.saveProjectInfo({ id: project.id, requiredSecrets: required });
    return { declared, waiting };
  }

  async keep(projectId: string, key: string, value: string): Promise<void> {
    if ((await this.deps.vault.read(projectId, key)) === value) return;
    await this.deps.vault.put(projectId, key, value, 'Carried over from the running app');
  }

  async signIns(project: Pick<ProjectMetadata, 'id' | 'ownerId' | 'requiredSecrets'>, fallback: readonly TreeTypeSecret[] = []): Promise<SignIn[]> {
    const declared = await this.declared(project);
    const signing = (declared.length > 0 ? declared : fallback.filter((secret) => project.requiredSecrets?.some((required) => required.key === secret.key))).filter((secret) => secret.signInAs);
    const out: SignIn[] = [];
    for (const secret of signing) {
      const password = await this.deps.vault.read(project.id, secret.key);
      if (password) out.push({ login: secret.signInAs!, password, describe: secret.describe });
    }
    return out;
  }

  private async ask(ownerId: string, projectId: string, secret: TreeTypeSecret, treeId: string | undefined): Promise<void> {
    const open = (await this.deps.requests.list(ownerId, { projectId })).some((request) => request.key === secret.key && request.status === 'requested');
    if (open) return;
    const stamp = (this.deps.now ?? (() => new Date().toISOString()))();
    const request: SecretRequest = {
      id: (this.deps.newId ?? uuidv4)(),
      ownerId,
      projectId,
      key: secret.key,
      description: secret.describe,
      secretReference: secretReference(projectId, secret.key),
      status: 'requested',
      ...(treeId ? { treeId } : {}),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.deps.requests.save(request);
    this.deps.asked?.(request);
  }
}

export function projectSecretsFor(deps: {
  db: Pick<ProjectsStore, 'getTreeTypes' | 'getTrees' | 'getSecretRequests' | 'saveSecretRequest' | 'saveProjectInfo'>;
  backend: VaultBackend & { getSecret(projectId: string, key: string): Promise<string | null>; listSecrets(projectId: string): Promise<{ key: string }[]> };
  readToken: (ownerId: string) => Promise<string>;
  asked?: ((request: SecretRequest) => void) | undefined;
}): ProjectSecretsService {
  const vault = createSecretVault({ backend: deps.backend, minters: { readToken: deps.readToken } });
  return new ProjectSecretsService({
    vault: {
      has: vault.has,
      mint: vault.mint,
      read: (projectId, key) => deps.backend.getSecret(projectId, key),
      put: async (projectId, key, value, comment) => { await deps.backend.setSecret(projectId, key, value, comment); },
    },
    treeTypes: (ownerId) => deps.db.getTreeTypes(ownerId),
    trees: () => deps.db.getTrees(),
    requests: { list: (ownerId, filter) => deps.db.getSecretRequests(ownerId, filter), save: (request) => deps.db.saveSecretRequest(request) },
    saveProjectInfo: (project) => deps.db.saveProjectInfo(project),
    ...(deps.asked ? { asked: deps.asked } : {}),
  });
}
