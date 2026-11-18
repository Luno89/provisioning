import { describe, expect, it } from 'vitest';
import { objectKey, releaseKey } from '../../../../../packages/cdktf-infra/lib/platform-objects.js';
import { PLATFORM_SERVICES, platformSettingsFrom } from '../../../../../packages/cdktf-infra/lib/platform-settings.js';
import { existingOnCluster, orphanedIngressWebhook, PLATFORM_PLAN, platformSecretManifests, platformStackEnv, secretStamp } from './platform-provision.js';

const VALUES = { 'gitea-admin': { username: 'provisioning-bot', password: 'pw' } };

describe('the platform services Koala puts on the cluster it runs in', () => {
  it('are applied in the order the stacks say, each named for the person', () => {
    expect(PLATFORM_PLAN.map((service) => service.key)).toEqual([...PLATFORM_SERVICES]);
    expect(PLATFORM_PLAN.map((service) => service.what)).toEqual(['the egress proxy', 'SearXNG', 'Crawl4AI', 'Gitea', 'the npm registry mirror', 'Infisical']);
  });

  it('keep each secret in a Secret of its own namespace, made before the stack that reads it by name', () => {
    const gitea = PLATFORM_PLAN.find((service) => service.key === 'gitea')!;
    expect(platformSecretManifests(gitea, VALUES)).toEqual([
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'gitea' } },
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'pipeline-builds' } },
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'gitea-admin', namespace: 'gitea' }, type: 'Opaque', stringData: { username: 'provisioning-bot', password: 'pw' } },
    ]);
    expect(() => platformSecretManifests(gitea, {})).toThrow('Gitea\'s Secret gitea-admin was given no values');
  });

  it('say where each secret comes from: a file in the data folder Koala keeps, or the setting the chart made', () => {
    const sources = Object.fromEntries(PLATFORM_PLAN.flatMap((service) => service.secrets.map((secret) => [`${secret.namespace}/${secret.name}`, secret.values])));
    expect(sources).toEqual({
      'searxng/searxng-secret': { secret_key: { file: '.searxng-secret-key', make: { bytes: 32, as: 'hex' } } },
      'crawl4ai/crawl4ai-secret': { api_token: { setting: 'crawl4aiToken' } },
      'gitea/gitea-admin': { username: { text: 'provisioning-bot' }, password: { file: '.gitea-admin-password', make: { bytes: 24, as: 'base64' } } },
      'infisical/infisical-secrets': {
        ENCRYPTION_KEY: { file: '.infisical-encryption-key', make: { bytes: 16, as: 'hex' } },
        AUTH_SECRET: { file: '.infisical-auth-secret', make: { bytes: 32, as: 'base64' } },
        ADMIN_PASSWORD: { file: '.infisical-admin-password', make: { bytes: 24, as: 'base64' } },
      },
      'infisical/infisical-store-passwords': {
        postgres: { file: '.infisical-postgres-password', make: { bytes: 16, as: 'hex' } },
        redis: { file: '.infisical-redis-password', make: { bytes: 16, as: 'hex' } },
      },
    });
  });

  it('stamp a service\'s pods with what changes when its secrets do, and never with the secrets themselves', () => {
    const stamp = secretStamp({ 'searxng-secret': { secret_key: 'one' } });
    expect(stamp).toMatch(/^[0-9a-f]{16}$/);
    expect(secretStamp({ 'searxng-secret': { secret_key: 'two' } })).not.toBe(stamp);
    expect(secretStamp({ 'searxng-secret': { secret_key: 'one' } })).toBe(stamp);
    expect(secretStamp({})).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('what is already on the cluster', () => {
  it('is named the way the stacks name what they make, so each stack takes over exactly what is there', () => {
    const namespaces = { items: [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'gitea' } }, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default' } }] };
    const inGitea = { items: [{ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'pipeline-build-sa', namespace: 'pipeline-builds' } }] };
    const releases = [[{ name: 'gitea', namespace: 'gitea', status: 'deployed', chart: 'gitea-12.7.0' }]];
    expect(existingOnCluster(['gitea', 'pipeline-builds'], namespaces, [inGitea], releases)).toEqual([
      objectKey({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'gitea' } }),
      objectKey({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'pipeline-build-sa', namespace: 'pipeline-builds' } }),
      releaseKey('gitea', 'gitea'),
    ]);
  });
});

describe('what a platform stack is handed', () => {
  it('is what the stack reads: the service, what is there, whose namespace, where it runs and its secrets\' stamp', () => {
    const env = platformStackEnv({ service: 'gitea', kubeconfigPath: '/tmp/kubeconfig-koala', existing: ['helm/gitea/gitea'], koalaNamespace: 'nowrinkles', pool: true, stamp: '0123456789abcdef' });
    expect(env).toEqual({ STACK_TYPE: 'platform', KUBECONFIG_PATH: '/tmp/kubeconfig-koala', PLATFORM_SERVICE: 'gitea', PLATFORM_EXISTING: '["helm/gitea/gitea"]', KOALA_NAMESPACE: 'nowrinkles', POOL: 'true', SECRET_STAMP: '0123456789abcdef' });
    expect(platformSettingsFrom(env)).toEqual({ name: 'gitea', inputs: { existing: new Set(['helm/gitea/gitea']), koalaNamespace: 'nowrinkles', pool: true, stamp: '0123456789abcdef' } });
  });
});

describe('an ingress admission webhook a failed Infisical install left behind', () => {
  it('stops Infisical with what to do while it would refuse every Ingress on the cluster', () => {
    expect(orphanedIngressWebhook({ items: [] })).toBeUndefined();
    expect(orphanedIngressWebhook({ items: [{ metadata: { name: 'infisical-ingress-nginx-admission' }, webhooks: [{ clientConfig: { caBundle: 'LS0t' } }] }] })).toBeUndefined();
    expect(orphanedIngressWebhook({ items: [{ metadata: { name: 'infisical-ingress-nginx-admission' }, webhooks: [{ clientConfig: {} }] }] }))
      .toBe('the webhook infisical-ingress-nginx-admission has no certificate authority, so every Ingress on the cluster is refused and no app can deploy; remove it with: kubectl delete validatingwebhookconfiguration infisical-ingress-nginx-admission');
  });
});
