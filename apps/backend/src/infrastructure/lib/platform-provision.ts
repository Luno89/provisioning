import { createHash } from 'node:crypto';
import { KOALA_PLATFORM_NAMESPACES as SPACES } from '@koala/engine-core/koala-install';
import type { HelmReleaseJson } from './platform-services.js';

export type SecretSource =
  | { file: string; make: { bytes: number; as: 'hex' | 'base64' } }
  | { setting: 'crawl4aiToken' | 'qdrantApiKey' }
  | { text: string };

export interface PlatformSecret {
  namespace: string;
  name: string;
  values: Record<string, SecretSource>;
}

export interface PlatformService {
  key: string;
  what: string;
  namespaces: readonly string[];
  watch: readonly string[];
  secrets: readonly PlatformSecret[];
  checkIngressWebhook?: true;
}

const hex = (file: string, bytes: number): SecretSource => ({ file, make: { bytes, as: 'hex' } });
const base64 = (file: string, bytes: number): SecretSource => ({ file, make: { bytes, as: 'base64' } });

export const PLATFORM_PLAN: readonly PlatformService[] = [
  { key: 'egress', what: 'the egress proxy', namespaces: SPACES.egress, watch: SPACES.egress, secrets: [] },
  { key: 'searxng', what: 'SearXNG', namespaces: SPACES.searxng, watch: SPACES.searxng, secrets: [{ namespace: 'searxng', name: 'searxng-secret', values: { secret_key: hex('.searxng-secret-key', 32) } }] },
  { key: 'crawl4ai', what: 'Crawl4AI', namespaces: SPACES.crawl4ai, watch: SPACES.crawl4ai, secrets: [{ namespace: 'crawl4ai', name: 'crawl4ai-secret', values: { api_token: { setting: 'crawl4aiToken' } } }] },
  { key: 'quickwit', what: 'Quickwit', namespaces: SPACES.quickwit, watch: SPACES.quickwit, secrets: [] },
  { key: 'qdrant', what: 'Qdrant', namespaces: SPACES.qdrant, watch: SPACES.qdrant, secrets: [{ namespace: 'qdrant', name: 'qdrant-secret', values: { api_key: { setting: 'qdrantApiKey' } } }] },
  { key: 'tei', what: 'TEI', namespaces: SPACES.tei, watch: SPACES.tei, secrets: [] },
  {
    key: 'gitea', what: 'Gitea', namespaces: SPACES.gitea, watch: ['gitea'],
    secrets: [{ namespace: 'gitea', name: 'gitea-admin', values: { username: { text: 'provisioning-bot' }, password: base64('.gitea-admin-password', 24) } }],
  },
  { key: 'verdaccio', what: 'the npm registry mirror', namespaces: SPACES.verdaccio, watch: SPACES.verdaccio, secrets: [] },
  {
    key: 'infisical', what: 'Infisical', namespaces: SPACES.infisical, watch: SPACES.infisical, checkIngressWebhook: true,
    secrets: [
      { namespace: 'infisical', name: 'infisical-secrets', values: { ENCRYPTION_KEY: hex('.infisical-encryption-key', 16), AUTH_SECRET: base64('.infisical-auth-secret', 32), ADMIN_PASSWORD: base64('.infisical-admin-password', 24) } },
      { namespace: 'infisical', name: 'infisical-store-passwords', values: { postgres: hex('.infisical-postgres-password', 16), redis: hex('.infisical-redis-password', 16) } },
    ],
  },
];

export type SecretValues = Record<string, Record<string, string>>;

export function platformSecretManifests(service: PlatformService, values: SecretValues): Array<Record<string, unknown>> {
  return [
    ...service.namespaces.map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } })),
    ...service.secrets.map((secret) => {
      const given = values[secret.name];
      if (!given) throw new Error(`${service.what}'s Secret ${secret.name} was given no values`);
      return { apiVersion: 'v1', kind: 'Secret', metadata: { name: secret.name, namespace: secret.namespace }, type: 'Opaque', stringData: given };
    }),
  ];
}

export function secretStamp(values: SecretValues): string {
  const sorted = Object.keys(values).sort().map((name) => [name, Object.entries(values[name]!).sort(([a], [b]) => a.localeCompare(b))]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

interface Listed { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string } }
const itemsOf = (listed: unknown): Listed[] => ((listed as { items?: Listed[] } | undefined)?.items ?? []);

// ── DUPLICATED, KNOWINGLY ── packages/cdktf-infra/lib/platform-objects.ts wins (objectKey, releaseKey); its test holds these to the same names.
const objectKey = (item: Listed): string => `${item.apiVersion ?? ''}/${item.kind ?? ''}/${item.metadata?.namespace ?? ''}/${item.metadata?.name ?? ''}`;
const releaseKey = (namespace: string, name: string): string => `helm/${namespace}/${name}`;

export function existingOnCluster(namespaces: readonly string[], namespaceList: unknown, objectLists: readonly unknown[], releases: readonly (readonly HelmReleaseJson[])[]): string[] {
  return [
    ...itemsOf(namespaceList).filter((item) => namespaces.includes(item.metadata?.name ?? '')).map(objectKey),
    ...objectLists.flatMap((listed) => itemsOf(listed).map(objectKey)),
    ...releases.flat().map((release) => releaseKey(release.namespace, release.name)),
  ];
}

export const PLATFORM_KINDS = 'configmaps,services,deployments.apps,persistentvolumeclaims,networkpolicies.networking.k8s.io,serviceaccounts';

export interface PlatformStackPlace {
  service: string;
  kubeconfigPath: string;
  existing: readonly string[];
  koalaNamespace: string;
  pool: boolean;
  stamp: string;
}

export const platformStackName = (service: string): string => `platform-${service}`;

export function platformStackEnv(place: PlatformStackPlace): Record<string, string> {
  return {
    STACK_TYPE: 'platform',
    KUBECONFIG_PATH: place.kubeconfigPath,
    PLATFORM_SERVICE: place.service,
    PLATFORM_EXISTING: JSON.stringify(place.existing),
    KOALA_NAMESPACE: place.koalaNamespace,
    POOL: String(place.pool),
    SECRET_STAMP: place.stamp,
  };
}

export const INGRESS_WEBHOOK = 'infisical-ingress-nginx-admission';

export function orphanedIngressWebhook(listed: unknown): string | undefined {
  const webhook = ((listed as { items?: Array<{ metadata?: { name?: string }; webhooks?: Array<{ clientConfig?: { caBundle?: string } }> }> })?.items ?? [])
    .find((item) => item.metadata?.name === INGRESS_WEBHOOK);
  if (!webhook || webhook.webhooks?.[0]?.clientConfig?.caBundle) return undefined;
  return `the webhook ${INGRESS_WEBHOOK} has no certificate authority, so every Ingress on the cluster is refused and no app can deploy; remove it with: kubectl delete validatingwebhookconfiguration ${INGRESS_WEBHOOK}`;
}
