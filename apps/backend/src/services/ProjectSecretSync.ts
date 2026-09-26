import { decryptValue, encryptValue } from '../lib/crypto.js';
import {
  OPERATOR_NAMESPACE, OPERATOR_RELEASE, OPERATOR_REPO,
  infisicalHostFor, infisicalSecretManifest, readerSecretManifest,
  type SecretTarget,
} from '../lib/infisical-sync.js';
import type { ProjectMetadata } from '../lib/types.js';

export const OPERATOR_VERSION = 'v0.11.10';

export interface SecretSyncInfra {
  runKubectl(args: string[], kubeconfig?: string): Promise<unknown>;
  runHelm(args: string[], kubeconfig?: string): Promise<unknown>;
  applyManifest(manifest: string, kubeconfig?: string): Promise<unknown>;
}

export interface SecretSyncVault {
  workspaceIdFor(projectId: string): Promise<string>;
  createProjectReader(projectId: string): Promise<{ clientId: string; clientSecret: string }>;
}

export interface SecretSyncProjects {
  saveProject(project: ProjectMetadata): Promise<void>;
}

export async function ensureInfisicalOperator(infra: SecretSyncInfra, kubeconfig: string): Promise<'present' | 'installed'> {
  const present = await infra.runHelm(['status', OPERATOR_RELEASE, '-n', OPERATOR_NAMESPACE], kubeconfig).then(() => true, () => false);
  if (present) return 'present';
  await infra.runHelm([
    'upgrade', '--install', OPERATOR_RELEASE, 'secrets-operator',
    '--repo', OPERATOR_REPO,
    '--version', OPERATOR_VERSION,
    '-n', OPERATOR_NAMESPACE, '--create-namespace',
    '--wait', '--timeout', '5m',
  ], kubeconfig);
  return 'installed';
}

export async function syncProjectSecrets(
  deps: { infra: SecretSyncInfra; vault: SecretSyncVault; projects: SecretSyncProjects; masterKey: string },
  args: { project: ProjectMetadata; namespace: string; kubeconfig: string; target: SecretTarget },
): Promise<{ hostAPI: string; operator: 'present' | 'installed' }> {
  const host = infisicalHostFor(args.target);
  if ('problem' in host) throw new Error(host.problem);

  const operator = await ensureInfisicalOperator(deps.infra, args.kubeconfig);

  let reader: { clientId: string; clientSecret: string } | undefined;
  if (args.project.infisicalReaderEnc) {
    try {
      reader = JSON.parse(decryptValue(args.project.infisicalReaderEnc, deps.masterKey));
    } catch {
      reader = undefined;
    }
  }
  if (!reader) {
    reader = await deps.vault.createProjectReader(args.project.id);
    await deps.projects.saveProject({ ...args.project, infisicalReaderEnc: encryptValue(JSON.stringify(reader), deps.masterKey) });
  }

  const workspaceId = await deps.vault.workspaceIdFor(args.project.id);
  await deps.infra.runKubectl(['create', 'namespace', args.namespace], args.kubeconfig).catch(() => undefined);
  await deps.infra.applyManifest(readerSecretManifest(args.namespace, reader), args.kubeconfig);
  await deps.infra.applyManifest(infisicalSecretManifest({
    namespace: args.namespace,
    hostAPI: host.hostAPI,
    workspaceId,
  }), args.kubeconfig);
  return { hostAPI: host.hostAPI, operator };
}
