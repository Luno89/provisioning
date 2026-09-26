import { NEVER_MOCK_PROVIDERS } from './cluster-topology.js';
import { DEFAULT_TARGET_CLUSTER } from './project-shipping.js';

export const INFISICAL_NODE_PORT = 31738;
export const INFISICAL_IN_CLUSTER = 'http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080';
export const OPERATOR_RELEASE = 'infisical-operator';
export const OPERATOR_NAMESPACE = 'infisical';
export const OPERATOR_REPO = 'https://dl.cloudsmith.io/public/infisical/helm-charts/helm/charts/';
export const READER_SECRET = 'infisical-auth';

export interface SecretTarget {
  clusterName: string;
  provider: string;
  isMock: boolean;
}

export function infisicalHostFor(target: SecretTarget): { hostAPI: string } | { problem: string } {
  if (target.clusterName === DEFAULT_TARGET_CLUSTER) return { hostAPI: INFISICAL_IN_CLUSTER };
  if (target.provider === 'k3d' || target.isMock) return { hostAPI: `http://host.k3d.internal:${INFISICAL_NODE_PORT}` };
  const where = NEVER_MOCK_PROVIDERS.includes(target.provider) ? 'a machine outside this node' : 'a cloud cluster';
  return { problem: `${target.clusterName} is ${where}, and the vault on this node is not reachable from it yet, so its secrets cannot be delivered` };
}

export const managedSecretName = (namespace: string): string => `${namespace}-secrets`;

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
    `    secretName: ${managedSecretName(args.namespace)}`,
    `    secretNamespace: ${args.namespace}`,
    '    creationPolicy: Owner',
    '',
  ].join('\n');
}
