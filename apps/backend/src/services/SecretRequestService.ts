import { GITEA_READ_TOKEN, valueProblem, withRequired, type SecretRequest } from '../lib/secret-requests.js';
import type { SecretRequestFilter } from '../lib/db-interface.js';
import type { ProjectMetadata } from '../lib/types.js';
import type { SecretVault } from '../engine-host/tools/secret-tools.js';

export interface VaultBackend {
  hasSecret(projectId: string, key: string): Promise<boolean>;
  setSecret(projectId: string, key: string, value: string, comment?: string): Promise<{ secretReference: string }>;
}

export interface SecretMinters {
  readToken(ownerId: string): Promise<string>;
}

export function createSecretVault(deps: { backend: VaultBackend; minters: SecretMinters }): SecretVault {
  return {
    has: (projectId, key) => deps.backend.hasSecret(projectId, key),
    async mint(ownerId, projectId, key, sourceId) {
      if (sourceId !== GITEA_READ_TOKEN.id) throw new Error(`no minter for ${sourceId}`);
      const token = await deps.minters.readToken(ownerId);
      await deps.backend.setSecret(projectId, key, token, `Provisioned automatically: ${GITEA_READ_TOKEN.label}`);
    },
  };
}

export interface SecretRequestStore {
  getSecretRequests(ownerId: string, filter?: SecretRequestFilter): Promise<SecretRequest[]>;
  getSecretRequest(ownerId: string, id: string): Promise<SecretRequest | undefined>;
  saveSecretRequest(request: SecretRequest): Promise<void>;
  getProjects(): Promise<ProjectMetadata[]>;
  saveProject(project: ProjectMetadata): Promise<void>;
}

export type SecretDecision =
  | { ok: true; request: SecretRequest }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string };

export class SecretRequestService {
  constructor(private readonly deps: { store: SecretRequestStore; vault: VaultBackend; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  list(ownerId: string, filter: SecretRequestFilter = {}): Promise<SecretRequest[]> {
    return this.deps.store.getSecretRequests(ownerId, filter);
  }

  private async open(ownerId: string, id: string): Promise<{ request: SecretRequest } | SecretDecision> {
    const request = await this.deps.store.getSecretRequest(ownerId, id);
    if (!request) return { ok: false, status: 404, error: 'Secret request not found' };
    if (request.status !== 'requested') return { ok: false, status: 409, error: `This request is already ${request.status}.` };
    return { request };
  }

  async submit(ownerId: string, id: string, value: string): Promise<SecretDecision> {
    const found = await this.open(ownerId, id);
    if (!('request' in found)) return found;
    const { request } = found;

    const problem = valueProblem(value);
    if (problem) return { ok: false, status: 400, error: problem };

    const project = (await this.deps.store.getProjects()).find((candidate) => candidate.id === request.projectId && candidate.ownerId === ownerId);
    if (!project) return { ok: false, status: 404, error: 'The project this secret belongs to no longer exists' };

    try {
      await this.deps.vault.setSecret(request.projectId, request.key, value, request.description);
    } catch (err) {
      return { ok: false, status: 502, error: `The vault did not accept ${request.key}: ${(err as Error).message}` };
    }

    await this.deps.store.saveProject({ ...project, requiredSecrets: withRequired(project.requiredSecrets, request.key, 'person') });
    const provided: SecretRequest = { ...request, status: 'provided', updatedAt: this.now() };
    await this.deps.store.saveSecretRequest(provided);
    return { ok: true, request: provided };
  }

  async dismiss(ownerId: string, id: string): Promise<SecretDecision> {
    const found = await this.open(ownerId, id);
    if (!('request' in found)) return found;
    const dismissed: SecretRequest = { ...found.request, status: 'dismissed', updatedAt: this.now() };
    await this.deps.store.saveSecretRequest(dismissed);
    return { ok: true, request: dismissed };
  }
}
