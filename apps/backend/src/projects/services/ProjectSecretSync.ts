import { decryptValue, encryptValue, type SecretKey, type ProjectMetadata, CLI_CEILING } from '../../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import {
  OPERATOR_NAMESPACE, OPERATOR_RELEASE, OPERATOR_REPO, infisicalHostFor, infisicalSecretManifest,
  readerSecretManifest, type SecretTarget,
} from '../../releases/index.js';

export const OPERATOR_VERSION = 'v0.11.10';

export interface SecretSyncInfra {
  runKubectl(args: string[], kubeconfig?: string): Promise<unknown>;
  runHelm(args: string[], kubeconfig?: string): Promise<unknown>;
  applyManifest(manifest: string, kubeconfig?: string): Promise<unknown>;
}

export interface SecretSyncVault {
  workspaceIdFor(projectId: string): Promise<string>;
  createProjectReader(projectId: string): Promise<{ clientId: string; clientSecret: string }>;
  readerWorks(reader: { clientId: string; clientSecret: string }): Promise<boolean>;
}

export interface SecretSyncProjects {
  saveProject(project: ProjectMetadata): Promise<void>;
}

export async function ensureInfisicalOperator(infra: SecretSyncInfra, kubeconfig: string): Promise<'present' | 'installed'> {
  const present = await infra.runHelm(['status', OPERATOR_RELEASE, '-n', OPERATOR_NAMESPACE], kubeconfig)
    .then(() => true, ignore('helm status fails while the operator is not installed, and installing it below fails with the reason when the cluster cannot be reached'));
  if (present) return 'present';
  await infra.runHelm([
    'upgrade', '--install', OPERATOR_RELEASE, 'secrets-operator',
    '--repo', OPERATOR_REPO,
    '--version', OPERATOR_VERSION,
    '-n', OPERATOR_NAMESPACE, '--create-namespace',
    '--wait', '--timeout', CLI_CEILING,
  ], kubeconfig);
  return 'installed';
}

const readerFrom = (value: unknown): { clientId: string; clientSecret: string } | undefined => {
  const reader = value && typeof value === 'object' ? value as { clientId?: unknown; clientSecret?: unknown } : undefined;
  return typeof reader?.clientId === 'string' && typeof reader.clientSecret === 'string'
    ? { clientId: reader.clientId, clientSecret: reader.clientSecret }
    : undefined;
};

export async function syncProjectSecrets(
  deps: { infra: SecretSyncInfra; vault: SecretSyncVault; projects: SecretSyncProjects; masterKey: SecretKey },
  args: { project: ProjectMetadata; namespace: string; kubeconfig: string; target: SecretTarget; secretName?: string | undefined },
): Promise<{ hostAPI: string; operator: 'present' | 'installed' }> {
  const host = infisicalHostFor(args.target);
  if ('problem' in host) throw new Error(host.problem);

  const operator = await ensureInfisicalOperator(deps.infra, args.kubeconfig);

  let reader: { clientId: string; clientSecret: string } | undefined;
  if (args.project.infisicalReaderEnc) {
    try {
      reader = readerFrom(JSON.parse(decryptValue(args.project.infisicalReaderEnc, deps.masterKey)) as unknown);
    } catch (failure) {
      ignore('a stored reader that cannot be read is replaced by a new one below')(failure);
    }
  }
  if (reader && !(await deps.vault.readerWorks(reader))) reader = undefined;
  if (!reader) {
    reader = await deps.vault.createProjectReader(args.project.id);
    await deps.projects.saveProject({ ...args.project, infisicalReaderEnc: encryptValue(JSON.stringify(reader), deps.masterKey) });
  }

  const workspaceId = await deps.vault.workspaceIdFor(args.project.id);
  await deps.infra.runKubectl(['create', 'namespace', args.namespace], args.kubeconfig)
    .catch(ignore('the namespace is usually there already, and when it cannot be made the manifests applied into it fail with the reason'));
  await deps.infra.applyManifest(readerSecretManifest(args.namespace, reader), args.kubeconfig);
  await deps.infra.applyManifest(infisicalSecretManifest({
    namespace: args.namespace,
    hostAPI: host.hostAPI,
    workspaceId,
    ...(args.secretName ? { secretName: args.secretName } : {}),
  }), args.kubeconfig);
  return { hostAPI: host.hostAPI, operator };
}
