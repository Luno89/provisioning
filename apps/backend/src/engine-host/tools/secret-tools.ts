import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import {
  descriptionProblem, keyProblem, secretReference, sourceFor, withRequired,
  type SecretRequest,
} from '../../lib/secret-requests.js';
import type { SecretRequestFilter } from '../../lib/db-interface.js';
import { primaryProjectId, type Tree } from '../../lib/trees.js';
import type { ProjectMetadata } from '../../lib/types.js';

export interface SecretVault {
  has(projectId: string, key: string): Promise<boolean>;
  mint(ownerId: string, projectId: string, key: string, sourceId: string): Promise<void>;
}

export interface SecretToolStores {
  requests: {
    list(ownerId: string, filter?: SecretRequestFilter): Promise<SecretRequest[]>;
    save(request: SecretRequest): Promise<void>;
  };
  projects: {
    list(): Promise<ProjectMetadata[]>;
    save(project: ProjectMetadata): Promise<void>;
  };
  trees: { list(): Promise<Tree[]> };
  binding?: (ownerId: string, conversationId: string) => Promise<{ treeId?: string | undefined; projectId?: string | undefined } | undefined>;
}

export interface SecretToolOptions {
  stores: SecretToolStores;
  vault?: SecretVault | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

const answer = (request: Pick<SecretRequest, 'key' | 'secretReference' | 'status'>, line: string): ToolOutcome => ({
  ok: true,
  digest: `${request.key}: ${request.status}`,
  content: `${line}\nkey: ${request.key}\nreference: ${request.secretReference}\nstatus: ${request.status}`,
});

export function createSecretTools(options: SecretToolOptions): Record<string, ToolHandler> {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;
  const { stores, vault } = options;

  const projectFor = async (
    ownerId: string,
    named: string | undefined,
    caller: { projectId?: string | undefined; conversationId?: string | undefined },
  ): Promise<{ project: ProjectMetadata; treeId?: string | undefined } | { problem: string }> => {
    const binding = caller.conversationId && stores.binding ? await stores.binding(ownerId, caller.conversationId) : undefined;
    const tree = binding?.treeId
      ? (await stores.trees.list()).find((candidate) => candidate.id === binding.treeId && candidate.ownerId === ownerId)
      : undefined;
    const projectId = named ?? caller.projectId ?? binding?.projectId ?? (tree ? primaryProjectId(tree) : undefined);
    if (!projectId) {
      return { problem: 'a secret belongs to a project, and this run is about none — name the projectId, or ask once approving the plan has created the project' };
    }
    const project = (await stores.projects.list()).find((candidate) => candidate.id === projectId && candidate.ownerId === ownerId);
    if (!project) return { problem: `no such project: ${projectId}` };
    const owningTree = tree ?? (await stores.trees.list()).find((candidate) => candidate.ownerId === ownerId && candidate.projectIds?.includes(project.id));
    return { project, ...(owningTree ? { treeId: owningTree.id } : {}) };
  };

  return {
    async request_secret({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to ask for a secret');
      const ownerId = caller.ownerId;
      if ('value' in parsed || 'secret' in parsed) {
        return refuse('never send a secret value — the person enters it on the card this tool shows them. Call again with only key and description');
      }

      const key = asString(parsed, 'key') ?? '';
      const keyIssue = keyProblem(key);
      if (keyIssue) return refuse(keyIssue);
      const description = asString(parsed, 'description') ?? '';
      const descriptionIssue = descriptionProblem(description);
      if (descriptionIssue) return refuse(descriptionIssue);

      const found = await projectFor(ownerId, asString(parsed, 'projectId') ?? asString(parsed, 'project_id'), caller);
      if ('problem' in found) return refuse(found.problem);
      const { project } = found;
      const reference = secretReference(project.id, key);

      const earlier = (await stores.requests.list(ownerId, { projectId: project.id })).filter((request) => request.key === key);
      const open = earlier.find((request) => request.status === 'requested');
      if (open) return answer(open, `${key} is already waiting for the person to enter it; nothing new was asked.`);
      const settled = earlier.find((request) => request.status === 'provided' || request.status === 'provisioned');
      if (settled) return answer(settled, `${key} is already in the vault for ${project.name}; the deployed service receives it as an environment variable.`);

      if (vault && await vault.has(project.id, key)) {
        return answer({ key, secretReference: reference, status: 'provided' }, `${key} is already in the vault for ${project.name}; the deployed service receives it as an environment variable.`);
      }

      const stamp = now();
      const base: SecretRequest = {
        id: newId(),
        ownerId,
        projectId: project.id,
        key,
        description,
        secretReference: reference,
        status: 'requested',
        ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
        ...(caller.runId ? { runId: caller.runId } : {}),
        ...(found.treeId ? { treeId: found.treeId } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      };

      const source = sourceFor(key);
      if (source && vault) {
        const minted = await vault.mint(ownerId, project.id, key, source.id).then(() => true, () => false);
        if (minted) {
          const provisioned: SecretRequest = { ...base, status: 'provisioned', source: source.id };
          await stores.requests.save(provisioned);
          await stores.projects.save({ ...project, requiredSecrets: withRequired(project.requiredSecrets, key, source.id) });
          return answer(provisioned, `${key} was provisioned automatically as ${source.label} and stored in the vault; nobody had to enter it.`);
        }
      }

      await stores.requests.save(base);
      return answer(base, `Asked the person for ${key} on a card; they enter it there and it goes straight into the vault. You never see the value, and do not need to — the deployed service receives it as an environment variable.`);
    },
  };
}
