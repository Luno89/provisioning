import { describe, it, expect } from 'vitest';
import { renderApp, MINIO_SPEC, type AppSpec } from './app-spec.js';

/**
 * The experiment: can a spec reproduce a hand-written construct?
 *
 * There are fifteen `-native` constructs totalling 3,038 lines building the same five resources.
 * `minio-native.ts` and `qdrant-native.ts` are both exactly 158 lines and identical in structure.
 * If a spec renders minio field for field, most of those lines were never code — and adding
 * MongoDB becomes a record rather than TypeScript.
 *
 * Every expectation below is read off `constructs/minio-native.ts`. Where they differ, the spec is
 * wrong, not the construct.
 */

const ctx = {
  id: 'abc123',
  namespace: 'minio',
  serviceType: 'NodePort',
  secrets: { root_user: 'koala', root_password: 'deadbeef' },
};

describe('minio, rendered from a spec', () => {
  const out = renderApp(MINIO_SPEC, ctx);

  it('creates the namespace the construct does', () => {
    expect(out.namespace).toEqual({ metadata: { name: 'minio' } });
  });

  it('creates the same Secret, plaintext for the provider to encode', () => {
    expect(out.secret).toEqual({
      metadata: { name: 'minio-secret', namespace: 'minio' },
      data: { root_user: 'koala', root_password: 'deadbeef' },
      type: 'Opaque',
    });
  });

  it('creates the same PVC', () => {
    expect(out.pvcs).toEqual([{
      metadata: { name: 'minio-data-pvc', namespace: 'minio' },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '100Gi' } } },
      waitUntilBound: false,
    }]);
  });

  it('builds the same container, down to the args and probes', () => {
    const container = (out.deployment as any).spec.template.spec.container[0];
    expect(container.name).toBe('minio');
    expect(container.image).toBe('minio/minio:latest');
    // The console address is explicit because MinIO otherwise picks a random port on restart.
    expect(container.args).toEqual(['server', '/data', '--console-address', ':9001']);
    expect(container.port).toEqual([
      { containerPort: 9000, name: 's3' },
      { containerPort: 9001, name: 'console' },
    ]);
    expect(container.volumeMount).toEqual([{ name: 'data', mountPath: '/data' }]);
    expect(container.resources).toEqual({
      limits: { memory: '2Gi', cpu: '2000m' },
      requests: { memory: '256Mi', cpu: '100m' },
    });
    expect(container.livenessProbe).toEqual({
      httpGet: { path: '/minio/health/live', port: '9000' },
      initialDelaySeconds: 10,
      periodSeconds: 20,
    });
    // `/ready`, not `/live`: a MinIO still scanning its disk answers live and refuses writes.
    expect(container.readinessProbe).toEqual({
      httpGet: { path: '/minio/health/ready', port: '9000' },
      initialDelaySeconds: 5,
      periodSeconds: 10,
    });
  });

  it('reads generated credentials from the Secret, never inline', () => {
    /**
     * The rule that keeps a spec safe to author: nothing that writes one ever holds the value, and
     * nothing that reads one can recover it.
     */
    const env = (out.deployment as any).spec.template.spec.container[0].env;
    expect(env).toEqual([
      { name: 'MINIO_ROOT_USER', valueFrom: { secretKeyRef: { name: 'minio-secret', key: 'root_user' } } },
      { name: 'MINIO_ROOT_PASSWORD', valueFrom: { secretKeyRef: { name: 'minio-secret', key: 'root_password' } } },
    ]);
    expect(JSON.stringify(env)).not.toContain('deadbeef');
  });

  it('builds the same Deployment shell, with labels and selector agreeing', () => {
    const dep = out.deployment as any;
    expect(dep.metadata).toEqual({ name: 'minio', namespace: 'minio', labels: { app: 'minio-abc123' } });
    expect(dep.spec.replicas).toBe('1');
    expect(dep.spec.selector).toEqual({ matchLabels: { app: 'minio-abc123' } });
    expect(dep.spec.template.metadata.labels).toEqual({ app: 'minio-abc123' });
  });

  it('builds the same Service', () => {
    expect(out.service).toEqual({
      metadata: { name: 'minio', namespace: 'minio' },
      spec: {
        type: 'NodePort',
        selector: { app: 'minio-abc123' },
        port: [
          { port: 9000, targetPort: '9000', name: 's3' },
          { port: 9001, targetPort: '9001', name: 'console' },
        ],
      },
    });
  });
});

describe('the rules that stay code', () => {
  it('forces Recreate when there is a volume', () => {
    /**
     * A ReadWriteOnce PVC cannot be mounted by two pods, so a rolling update deadlocks: the new pod
     * waits for the volume, which waits for the old pod, which waits for the new pod to be ready.
     * A rule, not a value — nobody authoring a spec should be able to get it wrong.
     */
    expect((renderApp(MINIO_SPEC, ctx).deployment as any).spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('leaves the strategy default when there is none', () => {
    // Without a volume a rolling update is correct, and forcing Recreate would cause downtime on
    // every deploy for no reason.
    const stateless: AppSpec = { id: 'tei', image: 'tei:1', ports: [{ name: 'http', port: 80 }] };
    const out = renderApp(stateless, { ...ctx, namespace: 'tei' });
    expect((out.deployment as any).spec.strategy).toBeUndefined();
    expect(out.pvcs).toEqual([]);
    expect(out.secret).toBeUndefined();
  });
});

describe('what a deployment may override', () => {
  it('takes a bigger disk without touching the spec', () => {
    // The spec is the app; the size is this deployment's. Editing the spec to grow one disk would
    // change it for everyone.
    const out = renderApp(MINIO_SPEC, { ...ctx, storage: { '/data': '500Gi' } });
    expect((out.pvcs[0]!.spec as any).resources.requests.storage).toBe('500Gi');
  });

  it('takes a memory limit, leaving the requests alone', () => {
    const container = (renderApp(MINIO_SPEC, { ...ctx, memoryLimit: '8Gi' }).deployment as any)
      .spec.template.spec.container[0];
    expect(container.resources.limits.memory).toBe('8Gi');
    expect(container.resources.limits.cpu).toBe('2000m');
    expect(container.resources.requests.memory).toBe('256Mi');
  });
});

describe('what this means for adding MongoDB', () => {
  it('is a record, with no code at all', () => {
    /**
     * The request that started this. Every field here is a value someone can write down, and the
     * renderer produces a working Deployment, Service, PVC and Secret from it.
     */
    const mongo: AppSpec = {
      id: 'mongo',
      image: 'mongo:7',
      ports: [{ name: 'mongo', port: 27017 }],
      env: [
        { name: 'MONGO_INITDB_ROOT_USERNAME', fromSecret: 'username', generate: 'username' },
        { name: 'MONGO_INITDB_ROOT_PASSWORD', fromSecret: 'password', generate: 'password' },
      ],
      volumes: [{ path: '/data/db', size: '10Gi' }],
      resources: { limits: { memory: '1Gi', cpu: '1000m' }, requests: { memory: '256Mi', cpu: '100m' } },
    };
    const out = renderApp(mongo, { ...ctx, namespace: 'mongo', secrets: { username: 'koala', password: 'x' } });

    expect((out.deployment as any).spec.strategy).toEqual({ type: 'Recreate' });
    expect(out.pvcs[0]!.metadata.name).toBe('mongo-data-pvc');
    expect((out.service as any).spec.port).toEqual([{ port: 27017, targetPort: '27017', name: 'mongo' }]);
    // Credentials generated and referenced, never authored.
    const env = (out.deployment as any).spec.template.spec.container[0].env;
    expect(env[1].valueFrom.secretKeyRef).toEqual({ name: 'mongo-secret', key: 'password' });
  });
});
