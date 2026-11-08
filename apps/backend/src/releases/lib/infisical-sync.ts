
export const OPERATOR_RELEASE = 'infisical-operator';
export const OPERATOR_NAMESPACE = 'infisical';
export const OPERATOR_REPO = 'https://dl.cloudsmith.io/public/infisical/helm-charts/helm/charts/';
export const READER_SECRET = 'infisical-auth';

export interface VaultReach {
  clusterId: string;
  kind: 'koala' | 'machine' | 'root';
}

export function infisicalHostFor(cluster: VaultReach, vault: { url: string }): { hostAPI: string } | { problem: string } {
  if (cluster.kind === 'koala') return { hostAPI: vault.url };
  const where = cluster.kind === 'machine' ? 'a machine outside Koala\'s own cluster' : 'root\'s own cluster, which keeps no project\'s secrets';
  return { problem: `${cluster.clusterId} is ${where}, and the vault in Koala's own cluster is not reachable from it, so its secrets cannot be delivered` };
}

export const managedSecretName = (namespace: string): string => `${namespace}-secrets`;
export const vaultSecretName = (namespace: string): string => `${namespace}-vault`;

const quoted = (value: string): string => JSON.stringify(value);

export function readerSecretManifest(namespace: string, reader: { clientId: string; clientSecret: string }): string {
  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${READER_SECRET}`,
    `  namespace: ${namespace}`,
    'type: Opaque',
    'stringData:',
    `  clientId: ${quoted(reader.clientId)}`,
    `  clientSecret: ${quoted(reader.clientSecret)}`,
    '',
  ].join('\n');
}

export function infisicalSecretManifest(args: {
  namespace: string;
  hostAPI: string;
  workspaceId: string;
  environment?: string | undefined;
  resyncSeconds?: number | undefined;
  secretName?: string | undefined;
}): string {
  return [
    'apiVersion: secrets.infisical.com/v1alpha1',
    'kind: InfisicalSecret',
    'metadata:',
    '  name: project-secrets',
    `  namespace: ${args.namespace}`,
    'spec:',
    `  hostAPI: ${quoted(`${args.hostAPI}/api`)}`,
    `  resyncInterval: ${args.resyncSeconds ?? 60}`,
    '  authentication:',
    '    universalAuth:',
    '      credentialsRef:',
    `        secretName: ${READER_SECRET}`,
    `        secretNamespace: ${args.namespace}`,
    '      secretsScope:',
    `        projectId: ${quoted(args.workspaceId)}`,
    `        envSlug: ${quoted(args.environment ?? 'dev')}`,
    '        secretsPath: "/"',
    '  managedSecretReference:',
    `    secretName: ${args.secretName ?? managedSecretName(args.namespace)}`,
    `    secretNamespace: ${args.namespace}`,
    '    creationPolicy: Owner',
    '',
  ].join('\n');
}
