import { describe, expect, it } from 'vitest';
import { registryHosts } from './registry-hosts.js';
import { REGISTRY_PULL_SECRET, dockerConfigJson, manifestList, pullingServiceAccount, registryPullManifests, registryPullSecret, type RegistryLogin } from './registry-pull.js';

const one = registryHosts('http://10.0.0.130:31737', undefined);
const pool = registryHosts('http://gitea-http.gitea.svc.cluster.local:3000/', '127.0.0.1:35010');
const login = (hosts = one): RegistryLogin => ({ hosts, username: 'provisioning-bot', password: 'tok' });
const decoded = (secret: Record<string, unknown>) =>
  JSON.parse(Buffer.from((secret.data as Record<string, string>)['.dockerconfigjson']!, 'base64').toString('utf8'));

describe('pulling Koala-built images with a login', () => {
  it('writes one docker login for every address the registry is reached at', () => {
    const auth = Buffer.from('provisioning-bot:tok').toString('base64');
    expect(JSON.parse(dockerConfigJson(one, { username: 'provisioning-bot', password: 'tok' }))).toEqual({ auths: { '10.0.0.130:31737': { auth } } });
    expect(Object.keys(JSON.parse(dockerConfigJson(pool, { username: 'provisioning-bot', password: 'tok' })).auths)).toEqual(['gitea-http.gitea.svc.cluster.local:3000', '127.0.0.1:35010']);
  });

  it('puts the login in a dockerconfigjson secret of the namespace, as data a move can rewrite', () => {
    const secret = registryPullSecret('shop-a1b2c3', login());
    expect(secret).toMatchObject({ kind: 'Secret', type: 'kubernetes.io/dockerconfigjson', metadata: { name: REGISTRY_PULL_SECRET, namespace: 'shop-a1b2c3' } });
    expect(decoded(secret).auths['10.0.0.130:31737'].auth).toBe(Buffer.from('provisioning-bot:tok').toString('base64'));
  });

  it('has the namespace default service account pull with it', () => {
    expect(pullingServiceAccount('shop-a1b2c3')).toEqual({
      apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: 'shop-a1b2c3' }, imagePullSecrets: [{ name: REGISTRY_PULL_SECRET }],
    });
  });

  it('gives the secret before the service account naming it, as one list kubectl applies at once', () => {
    const manifests = registryPullManifests('shop-a1b2c3', login(pool));
    expect(manifests.map((manifest) => manifest.kind)).toEqual(['Secret', 'ServiceAccount']);
    expect(manifestList(manifests)).toEqual({ apiVersion: 'v1', kind: 'List', items: manifests });
  });
});
