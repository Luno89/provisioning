import { describe, it, expect } from 'vitest';
import { renderApp, MINIO_SPEC, type AppSpec } from './app-spec.js';

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
    expect(container.readinessProbe).toEqual({
      httpGet: { path: '/minio/health/ready', port: '9000' },
      initialDelaySeconds: 5,
      periodSeconds: 10,
    });
  });

  it('reads generated credentials from the Secret, never inline', () => {
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
    expect((renderApp(MINIO_SPEC, ctx).deployment as any).spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('leaves the strategy default when there is none', () => {
    const stateless: AppSpec = { id: 'tei', image: 'tei:1', ports: [{ name: 'http', port: 80 }] };
    const out = renderApp(stateless, { ...ctx, namespace: 'tei' });
    expect((out.deployment as any).spec.strategy).toBeUndefined();
    expect(out.pvcs).toEqual([]);
    expect(out.secret).toBeUndefined();
  });
});

describe('what a deployment may override', () => {
  it('takes a bigger disk without touching the spec', () => {
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
    const env = (out.deployment as any).spec.template.spec.container[0].env;
    expect(env[1].valueFrom.secretKeyRef).toEqual({ name: 'mongo-secret', key: 'password' });
  });
});

describe('the contract with the construct', () => {
  const out = renderApp(MINIO_SPEC, ctx);

  it('survives the JSON round trip it actually makes', () => {
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('provides every field the construct reads', () => {
    expect(out.namespace.metadata.name).toBeTruthy();
    expect(out.secret?.metadata.name).toBeTruthy();
    expect(Array.isArray(out.pvcs)).toBe(true);
    expect((out.deployment as any).spec.template.spec).toBeTruthy();
    expect((out.service as any).metadata.name).toBeTruthy();
  });

  it('tells the platform where to probe, using LIVENESS', () => {
    expect(out.health).toEqual({ port: 9000, path: '/minio/health/live' });
  });

  it('exposes the console, not the API, to a browser', () => {
    expect(out.ingressPort).toBe(9001);
  });

  it('asks for no ingress when there is nothing to open', () => {
    const db: AppSpec = {
      id: 'mongo', image: 'mongo:7', ports: [{ name: 'mongo', port: 27017 }],
      resources: { limits: { memory: '1Gi', cpu: '1' } },
    };
    const rendered = renderApp(db, { ...ctx, namespace: 'mongo' });
    expect(rendered.ingressPort).toBeUndefined();
    expect(rendered.health).toBeUndefined();
  });
});
