import { describe, it, expect } from 'vitest';
import { buildManifests, labelValue, workspaceName, type RunWorkspace } from './workspace.js';

const LONG_RUN = 'eval2-6daa66c6-7dab-4acf-bf6d-c54e42840637-executor-reads-what-is-there';

const workspace = (over: Partial<RunWorkspace> = {}): RunWorkspace => ({
  runId: 'run-1',
  ownerId: 'user-1',
  agent: 'executor',
  image: 'registry.access.redhat.com/ubi9/nodejs-22',
  provides: ['bash', 'node'],
  egressMode: 'declared',
  lifetimeMs: 600_000,
  cpu: '2',
  memory: '2Gi',
  env: [],
  egress: [],
  ...over,
});

describe('naming a workspace after a run', () => {
  it('keeps a short run id as it is', () => {
    expect(workspaceName('run-1')).toBe('koala-run-run-1');
  });

  it('fits a long run id into what Kubernetes accepts, and stays stable', () => {
    const name = workspaceName(LONG_RUN);

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(workspaceName(LONG_RUN)).toBe(name);
  });

  it('gives two long run ids that share a prefix different names', () => {
    expect(workspaceName(`${LONG_RUN}-one`)).not.toBe(workspaceName(`${LONG_RUN}-two`));
  });

  it('refuses a run id with nothing to name a workspace after', () => {
    expect(() => workspaceName('///')).toThrow(/Cannot name a workspace/);
  });
});

describe('labelling a workspace', () => {
  it('leaves a value Kubernetes already accepts alone', () => {
    expect(labelValue('executor')).toBe('executor');
  });

  it('cuts a value that is too long down to the limit', () => {
    const value = labelValue(LONG_RUN);

    expect(value.length).toBeLessThanOrEqual(63);
    expect(value).toMatch(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/);
  });

  it('puts only values Kubernetes accepts on the manifests of a long run', () => {
    const manifests = buildManifests(workspace({ runId: LONG_RUN })) as { metadata: { labels: Record<string, string> } }[];

    for (const manifest of manifests) {
      for (const [key, value] of Object.entries(manifest.metadata.labels ?? {})) {
        expect(value.length, `${key} is too long`).toBeLessThanOrEqual(63);
        expect(value, key).toMatch(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/);
      }
    }
  });
});

describe('a workspace pulling a Koala-built image', () => {
  const login = { hosts: { push: 'gitea-http.gitea.svc.cluster.local:3000', pull: '127.0.0.1:35010' }, username: 'provisioning-bot', password: 'tok' };

  it('carries the registry login as a secret of its namespace, before the pod that names it', () => {
    const manifests = buildManifests(workspace(), login);
    const kinds = manifests.map((manifest) => manifest.kind);
    const secret = manifests.find((manifest) => manifest.kind === 'Secret') as { type: string; metadata: { name: string; namespace: string; labels: Record<string, string> }; data: Record<string, string> };
    expect(kinds.indexOf('Secret')).toBeGreaterThan(kinds.indexOf('Namespace'));
    expect(kinds.indexOf('Secret')).toBeLessThan(kinds.indexOf('Pod'));
    expect(secret.type).toBe('kubernetes.io/dockerconfigjson');
    expect(secret.metadata).toMatchObject({ name: 'koala-registry-pull', namespace: workspaceName('run-1'), labels: { 'koala.dev/run': 'run-1' } });
    expect(Object.keys(JSON.parse(Buffer.from(secret.data['.dockerconfigjson']!, 'base64').toString()).auths)).toEqual(['gitea-http.gitea.svc.cluster.local:3000', '127.0.0.1:35010']);
    const pod = manifests.find((manifest) => manifest.kind === 'Pod') as { spec: { imagePullSecrets?: unknown } };
    expect(pod.spec.imagePullSecrets).toEqual([{ name: 'koala-registry-pull' }]);
  });

  it('asks for no secret when it is given no login', () => {
    const manifests = buildManifests(workspace());
    expect(manifests.some((manifest) => manifest.kind === 'Secret')).toBe(false);
    expect((manifests.find((manifest) => manifest.kind === 'Pod') as { spec: Record<string, unknown> }).spec.imagePullSecrets).toBeUndefined();
  });
});
