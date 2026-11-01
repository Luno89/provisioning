import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';

const REPO = resolve(__dirname, '../../../../..');
const HELM = resolve(REPO, 'bin/helm');
const CHART = resolve(REPO, 'charts/instance');

const required = ['instance.id=inst-u1', 'instance.ownerId=u1', 'instance.rootUrl=https://app.example.com', 'instance.rootPublicKeys=PEM'];

interface Container {
  name: string;
  image: string;
  args?: string[];
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  envFrom?: unknown[];
  ports?: unknown[];
  resources?: unknown;
  restartPolicy?: string;
  readinessProbe?: { httpGet?: { path?: string } };
  volumeMounts?: unknown[];
  lifecycle?: { preStop?: { exec?: { command: string[] } } };
}

interface PodSpec {
  containers: Container[];
  initContainers?: Container[];
  volumes?: Array<{ name: string; secret?: { items: Array<{ key: string; path?: string }> } }>;
  hostNetwork?: boolean;
  terminationGracePeriodSeconds?: number;
}

interface PodTemplate {
  metadata?: { labels?: Record<string, string> };
  spec: PodSpec;
}

interface Spec {
  template?: PodTemplate;
  jobTemplate?: { spec: { template: PodTemplate } };
  type?: string;
  ports?: Array<{ port: number; name?: string }>;
  policyTypes?: string[];
  podSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  ingress?: unknown[];
  schedule?: string;
  concurrencyPolicy?: string;
  strategy?: unknown;
}

interface Doc {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: Spec;
  data?: Record<string, string>;
  roleRef?: { name: string };
}

const isDoc = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string' && 'metadata' in value && typeof value.metadata === 'object';

function render(extra: string[] = [], kubeVersion = '1.31.0'): Doc[] {
  const out = execFileSync(HELM, ['template', 'luno', CHART, '--namespace', 'nowrinkles', '--kube-version', kubeVersion, ...[...required, ...extra].flatMap((value) => ['--set', value])], { encoding: 'utf8' });
  return parseAllDocuments(out).map((doc) => {
    const json: unknown = doc.toJSON();
    return json;
  }).filter(isDoc);
}

const find = (docs: Doc[], kind: string, name: string): Doc => {
  const found = docs.find((doc) => doc.kind === kind && doc.metadata.name === name);
  if (!found) throw new Error(`no ${kind} ${name} in the rendered chart`);
  return found;
};

const specOf = (doc: Doc): Spec => {
  if (!doc.spec) throw new Error(`${doc.kind} ${doc.metadata.name} has no spec`);
  return doc.spec;
};

const podOf = (doc: Doc): PodSpec => {
  const pod = doc.spec?.template?.spec;
  if (!pod) throw new Error(`${doc.kind} ${doc.metadata.name} runs no pods`);
  return pod;
};

describe('the instance chart', () => {
  it('runs the backend and all three workers from the one image, each as its own process', () => {
    const docs = render();
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const container = podOf(find(docs, 'Deployment', `luno-${process}`)).containers[0]!;
      expect(container.image).toBe('nowrinkles/app:dev');
      expect(container.args).toEqual([process]);
    }
  });

  it('pulls that image by the digest root released it under, whatever the tag points at now', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const docs = render([`image.digest=${digest}`, 'instance.credential=c']);
    const images = docs.flatMap((doc) => [
      ...(doc.spec?.template?.spec?.containers ?? []),
      ...(doc.spec?.template?.spec?.initContainers ?? []),
      ...(doc.spec?.jobTemplate?.spec?.template?.spec?.containers ?? []),
    ]).map((container: { image: string }) => container.image).filter((image: string) => image.startsWith('nowrinkles/app'));
    expect(images.length).toBeGreaterThan(4);
    expect(new Set(images)).toEqual(new Set([`nowrinkles/app:dev@${digest}`]));
  });

  it('configures every process as this owner\'s instance, trusting root and keeping its own keys', () => {
    const docs = render();
    expect(find(docs, 'ConfigMap', 'luno-env').data).toMatchObject({
      ROLE: 'instance', INSTANCE_ID: 'inst-u1', INSTANCE_OWNER_ID: 'u1', ROOT_URL: 'https://app.example.com', ROOT_PUBLIC_KEYS: 'PEM', NODE_ENV: 'production',
    });
    const keys = find(docs, 'Secret', 'luno-keys');
    expect(Object.keys(keys.data ?? {}).sort()).toEqual(['DATA_KEY', 'EGRESS_KEY', 'MONGO_ROOT_PASSWORD', 'PAYLOAD_KEY', 'SESSION_KEY', 'TEMPORAL_DB_PASSWORD', 'TEMPORAL_KEY']);
    expect(Buffer.from(keys.data!.DATA_KEY!, 'base64').toString().length).toBeGreaterThanOrEqual(32);
    expect(keys.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(Object.keys(keys.data ?? {})).not.toContain('ROOT_IDENTITY_KEY');
  });

  it('runs its own Mongo and Temporal, and points the app at them', () => {
    const docs = render();
    find(docs, 'StatefulSet', 'luno-mongo');
    find(docs, 'StatefulSet', 'luno-temporal-db');
    find(docs, 'Deployment', 'luno-temporal');
    const env = podOf(find(docs, 'Deployment', 'luno-backend')).containers[0]!.env;
    expect(env?.find((entry) => entry.name === 'MONGO_URI')?.value).toBe('mongodb://admin:$(MONGO_ROOT_PASSWORD)@luno-mongo:27017/provisioning?authSource=admin');
    expect(find(docs, 'ConfigMap', 'luno-env').data!.TEMPORAL_CONNECTION_ADDRESS).toBe('luno-temporal:7233');
  });

  it('keeps its Temporal inside the cluster, and offers the owner\'s machines only the gateway, on a node port they reach over the mesh', () => {
    const meshed = render(['mesh.address=100.64.0.7', 'mesh.loginServer=https://mesh.example.com']);
    expect(podOf(find(meshed, 'Deployment', 'luno-temporal')).containers[0]!.ports).toEqual([{ containerPort: 7233 }]);
    const gateway = specOf(find(meshed, 'Service', 'luno-machine-gateway'));
    expect([gateway.type, gateway.ports]).toEqual(['NodePort', [{ name: 'machine-gateway', port: 7234, targetPort: 'machine-gateway', nodePort: 30322 }]]);
    expect(podOf(find(meshed, 'Deployment', 'luno-backend')).containers[0]!.ports).toContainEqual({ name: 'machine-gateway', containerPort: 7234 });
    expect(find(meshed, 'ConfigMap', 'luno-env').data).toMatchObject({ MACHINE_TEMPORAL_ADDRESS: '100.64.0.7:30322', MESH_LOGIN_SERVER: 'https://mesh.example.com' });

    const alone = render();
    expect(alone.some((doc) => doc.kind === 'Service' && doc.metadata.name === 'luno-machine-gateway')).toBe(false);
    expect(find(alone, 'ConfigMap', 'luno-env').data!.MACHINE_TEMPORAL_ADDRESS).toBeUndefined();
  });

  it('runs Temporal with its JWT authorizer, its keys served beside it before it starts, and its unchecked internal frontend only inside its pod', () => {
    const docs = render();
    const pod = podOf(find(docs, 'Deployment', 'luno-temporal'));
    const env = Object.fromEntries((pod.containers[0]!.env ?? []).flatMap((entry) => (entry.value !== undefined ? [[entry.name, entry.value]] : [])));
    expect(env).toMatchObject({
      SERVICES: 'frontend:internal-frontend:history:matching:worker',
      USE_INTERNAL_FRONTEND: 'true',
      TEMPORAL_ADDRESS: '127.0.0.1:7236',
      TEMPORAL_AUTH_AUTHORIZER: 'default',
      TEMPORAL_AUTH_CLAIM_MAPPER: 'default',
      TEMPORAL_JWT_KEY_SOURCE1: 'http://127.0.0.1:7280/.well-known/temporal-jwks.json',
    });
    const [writer, server] = pod.initContainers ?? [];
    expect(writer).toMatchObject({ name: 'temporal-jwks', image: 'nowrinkles/app:dev', args: ['temporal-keys', '/keys/temporal-jwks.json'] });
    expect(writer?.env).toEqual([{ name: 'TEMPORAL_KEY', valueFrom: { secretKeyRef: { name: 'luno-keys', key: 'TEMPORAL_KEY' } } }]);
    expect(server).toMatchObject({ name: 'temporal-keys', restartPolicy: 'Always', startupProbe: { httpGet: { path: '/.well-known/temporal-jwks.json', port: 7280 } } });
    expect(find(docs, 'Secret', 'luno-keys').data).toHaveProperty('TEMPORAL_KEY');
    expect(specOf(find(docs, 'Service', 'luno-temporal')).ports?.map((port) => port.port)).toEqual([7233]);
  });

  it('speaks TLS to Temporal: a certificate for its service names, its key only in Temporal\'s pod, the CA in every process', () => {
    const docs = render();
    const secret = find(docs, 'Secret', 'luno-temporal-tls');
    expect(Object.keys(secret.data ?? {}).sort()).toEqual(['ca.crt', 'tls.crt', 'tls.key']);
    expect(secret.metadata.annotations).toMatchObject({ 'helm.sh/resource-policy': 'keep' });
    const temporal = podOf(find(docs, 'Deployment', 'luno-temporal'));
    const server = temporal.containers.find((container) => container.name === 'temporal');
    expect(server?.env).toEqual(expect.arrayContaining([{ name: 'TEMPORAL_TLS_FRONTEND_CERT', value: '/etc/temporal/tls/tls.crt' }, { name: 'TEMPORAL_TLS_FRONTEND_KEY', value: '/etc/temporal/tls/tls.key' }]));
    expect(temporal.volumes?.find((volume) => volume.name === 'temporal-tls')?.secret?.items.map((item) => item.key)).toEqual(['tls.crt', 'tls.key']);
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const pod = podOf(find(docs, 'Deployment', `luno-${process}`));
      expect(pod.volumes?.find((volume) => volume.name === 'temporal-ca')?.secret?.items).toEqual([{ key: 'ca.crt', path: 'ca.crt' }]);
    }
    expect(find(docs, 'ConfigMap', 'luno-env').data).toMatchObject({ TEMPORAL_TLS_CA: '/etc/koala/temporal-tls/ca.crt' });
  });

  it('serves Temporal\'s keys beside it as an ordinary container on a cluster too old for native sidecars', () => {
    const pod = podOf(find(render([], '1.28.8'), 'Deployment', 'luno-temporal'));
    expect(pod.initContainers?.map((container) => container.name)).toEqual(['temporal-jwks']);
    expect(pod.containers.map((container) => container.name)).toEqual(['temporal-keys', 'temporal']);
    expect(pod.containers[0]!.restartPolicy).toBeUndefined();
  });

  it('lets only its own pods reach its Temporal, Temporal\'s database and Mongo, never a sandbox or an app beside them', () => {
    const docs = render();
    const policy = specOf(find(docs, 'NetworkPolicy', 'luno-stores'));
    expect(policy.policyTypes).toEqual(['Ingress']);
    expect(policy.podSelector?.matchExpressions).toEqual([
      { key: 'app.kubernetes.io/instance', operator: 'In', values: ['luno'] },
      { key: 'app.kubernetes.io/component', operator: 'In', values: ['temporal-db', 'mongo'] },
    ]);
    const ownPods = { 'app.kubernetes.io/part-of': 'nowrinkles-instance', 'app.kubernetes.io/instance': 'luno' };
    expect(policy.ingress).toEqual([{ from: [{ podSelector: { matchLabels: ownPods } }] }]);
    const temporal = specOf(find(docs, 'NetworkPolicy', 'luno-temporal'));
    expect(temporal.policyTypes).toEqual(['Ingress']);
    expect(temporal.podSelector?.matchLabels).toEqual({ 'app.kubernetes.io/instance': 'luno', 'app.kubernetes.io/component': 'temporal' });
    expect(temporal.ingress).toEqual([{ from: [{ podSelector: { matchLabels: ownPods } }], ports: [{ port: 7233, protocol: 'TCP' }] }]);
    const pods = docs.flatMap((doc) => [doc.spec?.template?.metadata?.labels, doc.spec?.jobTemplate?.spec?.template?.metadata?.labels]).filter(Boolean);
    expect(pods.length).toBeGreaterThan(8);
    for (const labels of pods) expect(labels).toMatchObject(ownPods);
    for (const component of ['temporal', 'temporal-db', 'mongo']) {
      const store = docs.find((doc) => doc.spec?.template?.metadata?.labels?.['app.kubernetes.io/component'] === component);
      expect(store?.spec?.template?.spec.hostNetwork).toBeUndefined();
    }
  });

  it('owns the cluster it is installed in, and sets up its services there after install and every upgrade', () => {
    const docs = render();
    expect(find(docs, 'ClusterRoleBinding', 'luno-nowrinkles-owns-cluster').roleRef?.name).toBe('cluster-admin');
    for (const step of ['platform-services', 'seed']) {
      const job = find(docs, 'Job', `luno-${step}`);
      expect(job.metadata.annotations?.['helm.sh/hook']).toBe('post-install,post-upgrade');
      expect(podOf(job).containers[0]!.args).toEqual([step]);
      expect(podOf(job).containers[0]!.env).toContainEqual({ name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } });
    }
  });

  it('gives the host worker the machine\'s Docker only when asked, and exposes the backend on a node port only when given one', () => {
    const withDocker = podOf(find(render(), 'Deployment', 'luno-worker-host')).volumes;
    expect(withDocker?.map((volume) => volume.name)).toContain('docker-socket');
    const without = podOf(find(render(['hostDocker=false']), 'Deployment', 'luno-worker-host')).volumes;
    expect(without?.map((volume) => volume.name)).not.toContain('docker-socket');

    expect(specOf(find(render(), 'Service', 'luno')).type).toBe('ClusterIP');
    expect(specOf(find(render(['backend.nodePort=30320']), 'Service', 'luno'))).toMatchObject({ type: 'NodePort', ports: [{ nodePort: 30320 }] });
  });

  it('with a credential from root, keeps it in a Secret, hands it to the app and its setup jobs (which, without one, never wait for it), and checks root hourly for the version to run', () => {
    const plain = render();
    expect(plain.find((doc) => doc.kind === 'CronJob')).toBeUndefined();

    const joined = render(['instance.credential=cred-from-root']);
    const secret = find(joined, 'Secret', 'luno-instance') as Doc & { stringData?: Record<string, string> };
    expect(secret.stringData).toEqual({ INSTANCE_CREDENTIAL: 'cred-from-root' });
    expect(secret.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');

    const upgrade = specOf(find(joined, 'CronJob', 'luno-self-upgrade'));
    expect(upgrade.schedule).toBe('17 * * * *');
    expect(upgrade.concurrencyPolicy).toBe('Forbid');
    const container = upgrade.jobTemplate?.spec.template.spec.containers[0];
    expect(container?.args).toEqual(['self-upgrade']);
    expect(container?.env).toEqual(expect.arrayContaining([{ name: 'CURRENT_IMAGE_TAG', value: 'dev' }, { name: 'RELEASE_NAME', value: 'luno' }]));

    const backend = podOf(find(joined, 'Deployment', 'luno-backend')).containers[0]!;
    expect(backend.envFrom).toEqual(expect.arrayContaining([{ secretRef: { name: 'luno-instance' } }]));
    const setupJobs = (docs: Doc[]) => docs.filter((doc) => doc.kind === 'Job').map((doc) => podOf(doc).containers[0]!.envFrom as unknown[]);
    for (const envFrom of setupJobs(joined)) expect(envFrom).toEqual(expect.arrayContaining([{ secretRef: { name: 'luno-instance' } }]));
    expect(setupJobs(plain).length).toBeGreaterThan(0);
    for (const envFrom of setupJobs(plain)) expect(envFrom).not.toEqual(expect.arrayContaining([{ secretRef: { name: 'luno-instance' } }]));
  });

  it('upgrades each process by starting the new one before stopping the old, and only once it is healthy', () => {
    const docs = render();
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const deployment = specOf(find(docs, 'Deployment', `luno-${process}`));
      expect(deployment.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
      expect(deployment.template?.spec.containers[0]?.readinessProbe?.httpGet?.path, process).toBe(process === 'backend' ? '/api/auth/sign-in' : '/healthz');
    }
  });

  it('lets the backend drain on its own when it is replaced: it knows its pod, Kubernetes waits for it, and the edge stops after it', () => {
    const docs = render(['routing.domain=koala.dev', 'routing.name=luno', 'edge.nodePort=30321']);
    const pod = podOf(find(docs, 'Deployment', 'luno-backend'));
    expect(pod.terminationGracePeriodSeconds).toBe(604800);
    const [backend, edge] = pod.containers;
    expect(backend?.env).toEqual(expect.arrayContaining([
      { name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
      { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
    ]));
    expect(edge?.lifecycle?.preStop?.exec?.command.join(' ')).toContain('until ! wget -q -O /dev/null http://127.0.0.1:3001/api/auth/sign-in');
    expect(podOf(find(docs, 'Deployment', 'luno-worker-engine')).terminationGracePeriodSeconds).toBeUndefined();
  });

  it('refuses to render without knowing whose instance it is', () => {
    expect(() => execFileSync(HELM, ['template', 'x', CHART], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/instance.id is required/);
  });

  it('serves the instance\'s apps through an edge beside the backend, only when root gives it addresses', () => {
    const plain = render();
    expect(plain.some((doc) => doc.metadata.name === 'luno-edge')).toBe(false);
    expect(podOf(find(plain, 'Deployment', 'luno-backend')).containers).toHaveLength(1);

    const docs = render(['routing.domain=koala.dev', 'routing.name=luno', 'edge.nodePort=30321']);
    expect(find(docs, 'ConfigMap', 'luno-env').data).toMatchObject({ INGRESS_DOMAIN: 'koala.dev', INSTANCE_NAME: 'luno', EDGE_ADMIN_URL: 'http://localhost:2019', EDGE_CADDYFILE: '/etc/edge/Caddyfile' });
    expect(find(docs, 'ConfigMap', 'luno-edge').data!.Caddyfile).toContain('import /app/apps/backend/data/caddy/apps/*.caddy');
    expect(find(docs, 'ConfigMap', 'luno-edge').data!.Caddyfile).toContain('header X-Koala-Edge "luno"');
    const [backend, edge] = podOf(find(docs, 'Deployment', 'luno-backend')).containers;
    expect(edge?.image).toBe('caddy:2.10.2-alpine');
    expect(edge?.volumeMounts).toEqual(expect.arrayContaining([{ name: 'data', mountPath: '/app/apps/backend/data', readOnly: true }]));
    expect(backend?.volumeMounts).toEqual(expect.arrayContaining([{ name: 'edge-config', mountPath: '/etc/edge', readOnly: true }]));
    expect(specOf(find(docs, 'Service', 'luno-edge'))).toMatchObject({ type: 'NodePort', ports: [{ name: 'edge', port: 80, targetPort: 'edge', nodePort: 30321 }] });
    expect(podOf(find(docs, 'Deployment', 'luno-worker-engine')).containers).toHaveLength(1);
  });

  it('in the pool, never mounts the machine\'s Docker, and reaches Gitea, Infisical and its registry by the addresses a vcluster has', () => {
    expect(() => render(['pool.enabled=true'])).toThrow(/pool.registryPullHost is required/);
    const docs = render(['pool.enabled=true', 'pool.registryPullHost=127.0.0.1:35010']);
    const host = podOf(find(docs, 'Deployment', 'luno-worker-host'));
    expect(host.volumes?.map((volume) => volume.name)).not.toContain('docker-socket');
    expect(find(docs, 'ConfigMap', 'luno-env').data).toMatchObject({
      POOL: 'true',
      GITEA_URL: 'http://gitea-http.gitea.svc.cluster.local:3000',
      INFISICAL_URL: 'http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080',
      REGISTRY_PULL_HOST: '127.0.0.1:35010',
      KOALA_REGISTRY: '127.0.0.1:35010',
      KOALA_REGISTRY_PUSH: 'gitea-http.gitea.svc.cluster.local:3000',
    });
    expect(find(render(), 'ConfigMap', 'luno-env').data).not.toHaveProperty('POOL');
  });

  it('on the owner\'s machine, reaches Gitea and Infisical inside the cluster and pulls what Koala builds through the machine\'s loopback only', () => {
    expect(find(render(), 'ConfigMap', 'luno-env').data).toMatchObject({
      GITEA_URL: 'http://gitea-http.gitea.svc.cluster.local:3000',
      INFISICAL_URL: 'http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080',
      REGISTRY_PULL_HOST: '127.0.0.1:31737',
      KOALA_REGISTRY: '127.0.0.1:31737',
      KOALA_REGISTRY_PUSH: 'gitea-http.gitea.svc.cluster.local:3000',
    });
  });

  it('gives each component the memory and CPU it is given, and none when it is given none', () => {
    const docs = render(['resources.backend.limits.memory=1Gi', 'resources.mongo.requests.memory=300Mi', 'resources.temporalDb.limits.memory=256Mi', 'resources.temporal.requests.cpu=100m']);
    expect(podOf(find(docs, 'Deployment', 'luno-backend')).containers[0]!.resources).toEqual({ limits: { memory: '1Gi' } });
    expect(podOf(find(docs, 'StatefulSet', 'luno-mongo')).containers[0]!.resources).toEqual({ requests: { memory: '300Mi' } });
    expect(podOf(find(docs, 'StatefulSet', 'luno-temporal-db')).containers[0]!.resources).toEqual({ limits: { memory: '256Mi' } });
    expect(podOf(find(docs, 'Deployment', 'luno-temporal')).containers[0]!.resources).toEqual({ requests: { cpu: '100m' } });
    expect(podOf(find(render(), 'Deployment', 'luno-worker-engine')).containers[0]!.resources).toBeUndefined();
  });
});
