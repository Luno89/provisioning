import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { renderChart } from '../../../../../tests/coupling/chart-trace.js';
import { minioSettingsFrom } from '../../files/lib/minio-settings.js';
import { podPlaceFrom } from '../../platform/lib/drain.js';
import { loadKey } from '../../platform/lib/keys.js';
import { backendSettingsFrom, clusterWorkerSettingsFrom, databaseSettingsFrom, engineWorkerSettingsFrom, hostWorkerSettingsFrom, moveImportSettingsFrom, platformServicesSettingsFrom, selfUpgradeSettingsFrom, setupWaitsSettingsFrom } from '../../platform/lib/settings.js';

const REPO = resolve(__dirname, '../../../../..');
const HELM = resolve(REPO, 'bin/helm');
const CHART = resolve(REPO, 'charts/instance');

const required = ['instance.id=inst-u1', 'instance.ownerId=u1', 'instance.rootUrl=https://app.example.com', 'instance.rootPublicKeys=PEM', 'instance.credential=c', 'publicUrl=https://luno.example.com', 'storage.total=100Gi'];

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
  volumes?: Array<{ name: string; secret?: { items: Array<{ key: string; path?: string }> }; hostPath?: { path: string; type?: string } }>;
  hostAliases?: Array<{ ip: string; hostnames: string[] }>;
  hostNetwork?: boolean;
  hostPID?: boolean;
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
  metadata: { name: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  spec?: Spec;
  data?: Record<string, string>;
  roleRef?: { name: string };
}

const isDoc = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string' && 'metadata' in value && typeof value.metadata === 'object';

function render(extra: string[] = [], kubeVersion = '1.31.0'): Doc[] {
  const out = renderChart('luno', CHART, ['--namespace', 'nowrinkles', '--kube-version', kubeVersion, ...[...required, ...extra].flatMap((value) => ['--set', value])]);
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
  const pod = doc.spec?.template?.spec ?? doc.spec?.jobTemplate?.spec.template.spec;
  if (!pod) throw new Error(`${doc.kind} ${doc.metadata.name} runs no pods`);
  return pod;
};

describe('the instance chart', () => {
  it('names every container port as Kubernetes allows: at most 15 lowercase letters, digits and dashes, with a letter', () => {
    const names = render().flatMap((doc) => {
      const pod = doc.spec?.template?.spec ?? doc.spec?.jobTemplate?.spec.template.spec;
      const containers: unknown[] = pod ? [...(pod.containers ?? []), ...((pod as { initContainers?: unknown[] }).initContainers ?? [])] : [];
      return containers.flatMap((container) => ((container as { ports?: { name?: string }[] }).ports ?? []).flatMap((port) => (port.name ? [port.name] : [])));
    });
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !/^(?=.*[a-z])[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$/.test(name) || name.includes('--'))).toEqual([]);
  });

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
    expect(Object.keys(keys.data ?? {}).sort()).toEqual(['CRAWL4AI_API_TOKEN', 'DATA_KEY', 'EGRESS_KEY', 'MINIO_ROOT_PASSWORD', 'MINIO_ROOT_USER', 'MONGO_ROOT_PASSWORD', 'PAYLOAD_KEY', 'SESSION_KEY', 'TEMPORAL_DB_PASSWORD', 'TEMPORAL_KEY']);
    expect(Buffer.from(keys.data!.DATA_KEY!, 'base64').toString().length).toBeGreaterThanOrEqual(32);
    expect(keys.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(Object.keys(keys.data ?? {})).not.toContain('ROOT_IDENTITY_KEY');
  });

  it('runs its own Mongo and Temporal, and points the app at them', () => {
    const docs = render();
    const mongo = podOf(find(docs, 'StatefulSet', 'luno-mongo-stores')).containers[0]!;
    expect(mongo.args?.join('\n')).toMatch(/exec docker-entrypoint\.sh mongod --replSet rs0 --keyFile \/tmp\/mongo-keyfile --bind_ip_all/);
    find(docs, 'StatefulSet', 'luno-temporal-db-stores');
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
    expect(pod.initContainers?.map((container) => container.name)).toEqual(['temporal-jwks', 'temporal-plan', 'temporal-step-1-25-2', 'temporal-step-1-26-3', 'temporal-step-1-27-4', 'temporal-step-1-28-4']);
    expect(pod.containers.map((container) => container.name)).toEqual(['temporal-keys', 'temporal']);
    expect(pod.containers[0]!.restartPolicy).toBeUndefined();
  });

  it('lets only its own pods reach its Temporal, Temporal\'s database and Mongo, never a sandbox or an app beside them', () => {
    const docs = render();
    const policy = specOf(find(docs, 'NetworkPolicy', 'luno-stores'));
    expect(policy.policyTypes).toEqual(['Ingress']);
    expect(policy.podSelector?.matchExpressions).toEqual([
      { key: 'app.kubernetes.io/instance', operator: 'In', values: ['luno'] },
      { key: 'app.kubernetes.io/component', operator: 'In', values: ['temporal-db', 'mongo', 'minio'] },
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

  it('owns the cluster it is installed in, and sets up its services there with Jobs of their own on every install and upgrade, each after the one before it, with nothing for helm to wait on', () => {
    const docs = render();
    expect(find(docs, 'ClusterRoleBinding', 'luno-nowrinkles-owns-cluster').roleRef?.name).toBe('cluster-admin');
    const after: string[] = [];
    for (const step of ['platform-services', 'seed']) {
      const job = find(docs, 'Job', `luno-${step}-1`);
      expect(job.metadata.annotations?.['helm.sh/hook']).toBeUndefined();
      expect(job.metadata.labels?.['koala.app/setup']).toBe(step);
      expect((job.spec as { backoffLimit?: number }).backoffLimit).toBe(0);
      expect(podOf(job).containers[0]!.args).toEqual([step]);
      expect(podOf(job).containers[0]!.env).toContainEqual({ name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } });
      const waits = podOf(job).initContainers?.[0];
      expect(waits?.args).toEqual(['setup-waits']);
      expect(waits?.env).toEqual(expect.arrayContaining([{ name: 'SETUP_STEP', value: step }, { name: 'SETUP_AFTER', value: after.join(' ') }]));
      after.push(`luno-${step}-1`);
    }
    const moving = render(['move.enabled=true']);
    expect(podOf(find(moving, 'Job', 'luno-move-restore-1')).initContainers?.[0]?.env).toContainEqual({ name: 'SETUP_AFTER', value: 'luno-move-data-1 luno-platform-services-1' });
  });

  it('runs each process and setup step from a checkout on the machine under a watcher only when dev names one, read-only, the data volume still its own', () => {
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const pod = podOf(find(render(['dev.source=/home/me/koala-src']), 'Deployment', `luno-${process}`));
      expect(pod.volumes).toContainEqual({ name: 'source', hostPath: { path: '/home/me/koala-src', type: 'Directory' } });
      expect(pod.containers[0]!.volumeMounts?.slice(0, 2)).toEqual([{ name: 'source', mountPath: '/app', readOnly: true }, { name: 'data', mountPath: '/app/apps/backend/data' }]);
      expect(pod.containers[0]!.env).toContainEqual({ name: 'DEV_WATCH', value: 'true' });
      expect(JSON.stringify(podOf(find(render(), 'Deployment', `luno-${process}`)))).not.toContain('DEV_WATCH');
    }
    const aliased = render(['hostAliases[0].ip=10.42.0.1', 'hostAliases[0].hostnames[0]=koala.localhost', 'instance.credential=cred-from-root']);
    const koalas = ['luno-backend', 'luno-worker-engine', 'luno-worker-cluster', 'luno-worker-host'];
    const pods = aliased.filter((doc) => doc.kind === 'Job' || doc.kind === 'CronJob' || (doc.kind === 'Deployment' && koalas.includes(doc.metadata.name)));
    expect(pods.map((doc) => doc.kind)).toEqual(expect.arrayContaining(['Deployment', 'Job', 'CronJob']));
    for (const doc of pods) expect(podOf(doc).hostAliases, `${doc.kind} ${doc.metadata.name}`).toEqual([{ ip: '10.42.0.1', hostnames: ['koala.localhost'] }]);
    expect(podOf(find(render(['dev.source=/home/me/koala-src']), 'Job', 'luno-seed-1')).volumes).toContainEqual({ name: 'source', hostPath: { path: '/home/me/koala-src', type: 'Directory' } });
  });

  it('measures what Koala\'s own processes run only when dev asks it to, into the host\'s folder at its own path and under the host\'s pids, and refuses it for anything but a dev checkout', () => {
    const coverage = '/home/me/koala-src/tests/.coupling/live';
    const measured = render(['dev.source=/home/me/koala-src', `dev.coverage=${coverage}`]);
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const pod = podOf(find(measured, 'Deployment', `luno-${process}`));
      expect(pod.hostPID).toBe(true);
      expect(pod.volumes).toContainEqual({ name: 'coverage', hostPath: { path: coverage, type: 'Directory' } });
      const container = pod.containers[0]!;
      expect(container.volumeMounts).toContainEqual({ name: 'coverage', mountPath: coverage });
      expect(container.env).toEqual(expect.arrayContaining([
        { name: 'COUPLING_LIVE_DIR', value: coverage },
        { name: 'NODE_V8_COVERAGE', value: `${coverage}/raw` },
        { name: 'NODE_OPTIONS', value: '--enable-source-maps --import /app/tests/coupling/live-hook.mjs' },
      ]));
      const plain = JSON.stringify(podOf(find(render(['dev.source=/home/me/koala-src']), 'Deployment', `luno-${process}`)));
      for (const absent of ['hostPID', 'COUPLING_LIVE_DIR', 'NODE_V8_COVERAGE', 'NODE_OPTIONS', '"coverage"']) expect(plain).not.toContain(absent);
    }
    const others = measured.filter((doc) => ['Deployment', 'StatefulSet', 'Job', 'CronJob'].includes(doc.kind) && !/^luno-(backend|worker-(engine|cluster|host))$/.test(doc.metadata.name));
    expect(others.length).toBeGreaterThan(0);
    for (const doc of others) expect(JSON.stringify(podOf(doc)), `${doc.kind} ${doc.metadata.name}`).not.toMatch(/hostPID|COUPLING_LIVE_DIR|NODE_V8_COVERAGE/);
    const refused = (values: string[]) => () => execFileSync(HELM, ['template', 'luno', CHART, ...[...required, ...values].flatMap((value) => ['--set', value])], { encoding: 'utf8', stdio: 'pipe' });
    expect(refused([`dev.coverage=${coverage}`])).toThrow(/dev.coverage measures a dev instance's own checkout: it needs dev.source/);
    expect(refused(['dev.source=/home/me/koala-src', 'dev.coverage=tests/.coupling/live'])).toThrow(/dev.coverage is a folder on the host, named from \//);
  });

  it('gives no process the machine\'s Docker, names the machine it is on, and exposes the backend on a node port only when given one', () => {
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      expect(JSON.stringify(podOf(find(render(), 'Deployment', `luno-${process}`)))).not.toContain('docker');
    }
    expect(find(render(['instance.machineId=desk']), 'ConfigMap', 'luno-env').data?.INSTANCE_MACHINE_ID).toBe('desk');
    expect(find(render(), 'ConfigMap', 'luno-env').data?.CHECKS_API_URL).toMatch(/^http:\/\/luno\.[a-z0-9-]+\.svc\.cluster\.local\/api$/);
    expect(find(render(), 'ConfigMap', 'luno-env').data?.GITEA_REACHES_KOALA_AT).toMatch(/^http:\/\/luno\.[a-z0-9-]+\.svc\.cluster\.local$/);
    expect(find(render(['instance.machineId=']), 'ConfigMap', 'luno-env').data).not.toHaveProperty('INSTANCE_MACHINE_ID');

    expect(specOf(find(render(), 'Service', 'luno')).type).toBe('ClusterIP');
    expect(specOf(find(render(['backend.nodePort=30320']), 'Service', 'luno'))).toMatchObject({ type: 'NodePort', ports: [{ nodePort: 30320 }] });
  });

  it('takes its credential from root, refusing to render without one, keeps it in a Secret, hands it to the app and its setup jobs, and checks root hourly for the version to run', () => {
    expect(() => render(['instance.credential='])).toThrow('instance.credential is required');

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
    expect(setupJobs(joined).length).toBeGreaterThan(0);
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
    expect(() => execFileSync(HELM, ['template', 'x', CHART, '--set', 'storage.total=1Gi'], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/instance.id is required/);
  });

  it('refuses to render without the size of the volume its stores share', () => {
    const args = ['template', 'x', CHART, ...required.filter((value) => !value.startsWith('storage.')).flatMap((value) => ['--set', value])];
    expect(() => execFileSync(HELM, args, { encoding: 'utf8', stdio: 'pipe' })).toThrow(/storage.total is the size of the volume/);
  });

  it('keeps its data folder, Mongo, Temporal\'s database and MinIO on one volume of the size it is given, each in a folder of its own', () => {
    const docs = render(['storage.total=10Gi']);
    const volume = find(docs, 'PersistentVolumeClaim', 'luno-data') as Doc & { spec: { resources: { requests: { storage: string } } } };
    expect(volume.spec.resources.requests.storage).toBe('10Gi');
    expect(volume.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(docs.filter((doc) => doc.kind === 'PersistentVolumeClaim').map((doc) => doc.metadata.name)).toEqual(['luno-data']);
    const mounts = (name: string) => podOf(find(docs, 'StatefulSet', name)).containers[0]!.volumeMounts;
    expect(mounts('luno-mongo-stores')).toEqual([{ name: 'stores', mountPath: '/data/db', subPath: 'stores/mongo' }]);
    expect(mounts('luno-temporal-db-stores')).toEqual([{ name: 'stores', mountPath: '/var/lib/postgresql/data', subPath: 'stores/temporal-db' }]);
    expect(mounts('luno-minio')).toEqual([{ name: 'stores', mountPath: '/data', subPath: 'stores/minio' }]);
    for (const name of ['luno-mongo-stores', 'luno-temporal-db-stores', 'luno-minio']) {
      const doc = find(docs, 'StatefulSet', name) as Doc & { spec: { volumeClaimTemplates?: unknown } };
      expect(doc.spec.volumeClaimTemplates).toBeUndefined();
      expect(podOf(doc).volumes).toEqual([{ name: 'stores', persistentVolumeClaim: { claimName: 'luno-data' } }]);
    }
  });

  it('runs its MinIO from the pinned image with its console off, answering only S3 inside the cluster, ready when MinIO says so', () => {
    const docs = render();
    const service = specOf(find(docs, 'Service', 'luno-minio'));
    expect(service.type).toBeUndefined();
    expect(service.ports).toEqual([{ name: 's3', port: 9000 }]);
    const minio = podOf(find(docs, 'StatefulSet', 'luno-minio')).containers[0]!;
    expect(minio.image).toMatch(/^pgsty\/minio:RELEASE\.[0-9TZ-]+@sha256:[0-9a-f]{64}$/);
    expect(minio.args).toEqual(['server', '/data']);
    expect(minio.readinessProbe?.httpGet?.path).toBe('/minio/health/ready');
    expect(minio.env).toEqual([
      { name: 'MINIO_BROWSER', value: 'off' },
      { name: 'MINIO_ROOT_USER', valueFrom: { secretKeyRef: { name: 'luno-keys', key: 'MINIO_ROOT_USER' } } },
      { name: 'MINIO_ROOT_PASSWORD', valueFrom: { secretKeyRef: { name: 'luno-keys', key: 'MINIO_ROOT_PASSWORD' } } },
    ]);
    expect(find(docs, 'ConfigMap', 'luno-env').data).toMatchObject({ MINIO_ENDPOINT: 'luno-minio:9000', MINIO_BUCKET: 'koala' });
  });

  it('gives every process exactly what the backend reads its MinIO settings from, as the processes see it', () => {
    const docs = render();
    const keys = Object.fromEntries(Object.entries(find(docs, 'Secret', 'luno-keys').data ?? {}).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]));
    const env = { ...find(docs, 'ConfigMap', 'luno-env').data, ...keys };
    const settings = minioSettingsFrom(env);
    expect(settings).toMatchObject({ endPoint: 'luno-minio', port: 9000, useSSL: false, bucket: 'koala', accessKey: keys.MINIO_ROOT_USER, secretKey: keys.MINIO_ROOT_PASSWORD });
    expect(settings.accessKey).toHaveLength(20);
    expect(settings.secretKey).toHaveLength(40);
    for (const name of ['luno-backend', 'luno-worker-engine']) {
      const from = podOf(find(docs, 'Deployment', name)).containers[0]!.envFrom;
      expect(from).toEqual(expect.arrayContaining([{ configMapRef: { name: 'luno-env' } }, { secretRef: { name: 'luno-keys' } }]));
    }
  });

  it('gives each process every setting its reader requires, as the process sees them, and each reader takes them', () => {
    const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');
    const docs = render(['mesh.address=100.64.0.7', 'backend.nodePort=30320', 'instance.machineId=desk', `instance.rootPublicKeys=${rootKey}`]);
    const secretOf = (name: string) => Object.fromEntries(Object.entries(find(docs, 'Secret', name).data ?? {}).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]));
    const fromSecrets = { ...secretOf('luno-keys'), ...((find(docs, 'Secret', 'luno-instance') as Doc & { stringData?: Record<string, string> }).stringData ?? {}) };
    const given = { POD_NAMESPACE: 'nowrinkles', POD_IP: '10.42.0.9', KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' };
    const envOf = (process: string): Record<string, string> => {
      const container = podOf(find(docs, 'Deployment', `luno-${process}`)).containers[0]!;
      const base: Record<string, string> = { ...find(docs, 'ConfigMap', 'luno-env').data, ...fromSecrets };
      for (const entry of container.env ?? []) {
        const value = entry.value ?? (given as Record<string, string>)[entry.name] ?? base[entry.name];
        if (value !== undefined) base[entry.name] = value.replace(/\$\(([A-Z_]+)\)/g, (_, name: string) => base[name] ?? '');
      }
      return { ...base, KUBERNETES_SERVICE_HOST: given.KUBERNETES_SERVICE_HOST, KUBERNETES_SERVICE_PORT: given.KUBERNETES_SERVICE_PORT };
    };
    const backend = backendSettingsFrom(envOf('backend'));
    expect(backend).toMatchObject({ port: 3001, publicUrl: 'https://luno.example.com', appUrl: 'https://luno.example.com', production: true, trustProxy: 1, temporal: { address: 'luno-temporal:7233', namespace: 'default' }, terraform: { kind: 'kubernetes', namespace: 'nowrinkles' } });
    expect(backend.instance).toMatchObject({ credential: 'c', gatewayPort: 7234, machineTemporalAddress: '100.64.0.7:30322' });
    expect(backend.clusters.here).toEqual({ koalaMachineId: 'desk', root: false });
    expect(engineWorkerSettingsFrom(envOf('worker-engine'))).toMatchObject({ healthPort: 8090, temporalMetricsPort: 9464, instanceCredential: 'c' });
    expect(clusterWorkerSettingsFrom(envOf('worker-cluster'))).toMatchObject({ healthPort: 8090, temporalMetricsPort: 9464, machineMetricsUrl: 'http://100.64.0.7:30320/api/machines/metrics' });
    expect(hostWorkerSettingsFrom(envOf('worker-host'))).toMatchObject({ healthPort: 8090, temporalMetricsPort: 9464, root: undefined });
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const container = podOf(find(docs, 'Deployment', `luno-${process}`)).containers[0]!;
      const ports = (container.ports ?? []) as Array<{ name: string; containerPort: number }>;
      const env = envOf(process);
      if (process === 'backend') expect(ports).toEqual(expect.arrayContaining([{ name: 'http', containerPort: Number(env.PORT) }, { name: 'machine-gateway', containerPort: Number(env.MACHINE_GATEWAY_PORT) }]));
      else expect(ports).toEqual(expect.arrayContaining([{ name: 'health', containerPort: Number(env.HEALTH_PORT) }, { name: 'wf-metrics', containerPort: Number(env.TEMPORAL_METRICS_PORT ?? env.TEMPORAL_ENGINE_METRICS_PORT) }]));
    }
  });

  it('gives the self-upgrade, every setup step, the move and Temporal\'s key server what each one\'s reader requires, as the step sees it', () => {
    const fieldValues: Record<string, string> = { 'metadata.namespace': 'nowrinkles', 'status.podIP': '10.42.0.9' };
    const environment = (docs: Doc[], pod: PodSpec, name: string): Record<string, string> => {
      const container = [...(pod.initContainers ?? []), ...pod.containers].find((each) => each.name === name);
      if (!container) throw new Error(`no container ${name}`);
      const secret = (secretName: string): Record<string, string> => {
        const doc = find(docs, 'Secret', secretName) as Doc & { stringData?: Record<string, string> };
        return { ...Object.fromEntries(Object.entries(doc.data ?? {}).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')])), ...(doc.stringData ?? {}) };
      };
      const env: Record<string, string> = { KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' };
      for (const from of (container.envFrom ?? []) as Array<{ configMapRef?: { name: string }; secretRef?: { name: string } }>) {
        Object.assign(env, from.configMapRef ? find(docs, 'ConfigMap', from.configMapRef.name).data : secret(from.secretRef!.name));
      }
      for (const entry of (container.env ?? []) as Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string }; fieldRef?: { fieldPath: string } } }>) {
        const value = entry.value ?? (entry.valueFrom?.secretKeyRef ? secret(entry.valueFrom.secretKeyRef.name)[entry.valueFrom.secretKeyRef.key] : fieldValues[entry.valueFrom?.fieldRef?.fieldPath ?? '']);
        if (value !== undefined) env[entry.name] = value.replace(/\$\(([A-Z_]+)\)/g, (_, inner: string) => env[inner] ?? '');
      }
      return env;
    };
    const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');
    const fresh = render(['instance.machineId=desk', `instance.rootPublicKeys=${rootKey}`]);
    const upgrade = selfUpgradeSettingsFrom(environment(fresh, podOf(find(fresh, 'CronJob', 'luno-self-upgrade')), 'self-upgrade'));
    expect(upgrade).toMatchObject({ root: { url: 'https://app.example.com', instanceId: 'inst-u1', credential: 'c' }, release: { name: 'luno', namespace: 'nowrinkles', dataVersion: 1 } });
    expect(upgrade.clusters.here).toEqual({ koalaMachineId: 'desk', root: false });
    expect(databaseSettingsFrom(environment(fresh, podOf(find(fresh, 'Job', 'luno-seed-1')), 'seed')).mongo).toBeDefined();
    expect(setupWaitsSettingsFrom(environment(fresh, podOf(find(fresh, 'Job', 'luno-seed-1')), 'waits'))).toMatchObject({ step: 'seed', after: ['luno-platform-services-1'], podNamespace: 'nowrinkles', mongo: { dbName: 'provisioning' }, clusters: { here: { koalaMachineId: 'desk' } } });
    expect(setupWaitsSettingsFrom(environment(fresh, podOf(find(fresh, 'Job', 'luno-platform-services-1')), 'waits'))).toMatchObject({ step: 'platform-services', after: [] });
    expect(platformServicesSettingsFrom(environment(fresh, podOf(find(fresh, 'Job', 'luno-platform-services-1')), 'platform-services'))).toMatchObject({ podNamespace: 'nowrinkles', dataDir: '/app/apps/backend/data', terraform: { kind: 'kubernetes', namespace: 'nowrinkles' }, crawl4aiToken: expect.stringMatching(/^[A-Za-z0-9]{40}$/) as unknown, clusters: { here: { koalaMachineId: 'desk' } } });
    expect(loadKey(environment(fresh, podOf(find(fresh, 'Deployment', 'luno-temporal')), 'temporal-jwks'), 'temporal')).toBeDefined();
    expect(podPlaceFrom(environment(fresh, podOf(find(fresh, 'Deployment', 'luno-backend')), 'backend'))).toEqual({ ip: '10.42.0.9', namespace: 'nowrinkles' });
    const moving = render(['instance.machineId=desk', `instance.rootPublicKeys=${rootKey}`, 'move.enabled=true']);
    for (const step of ['move-data', 'move-restore']) {
      expect(moveImportSettingsFrom(environment(moving, podOf(find(moving, 'Job', `luno-${step}-1`)), step))).toMatchObject({ rootUrl: 'https://app.example.com', instanceId: 'inst-u1', credential: 'c', podNamespace: 'nowrinkles', dataDir: '/app/apps/backend/data', terraform: { kind: 'kubernetes' } });
    }
  });

  it('moves nothing on a fresh install: the hook that brings an older instance\'s Mongo and Postgres onto the shared volume renders only beside them', () => {
    expect(render().some((doc) => doc.metadata.name === 'luno-adopt-stores')).toBe(false);
  });

  it('runs its edge beside the backend on every instance, and gives it the public addresses root routes only when root gives it a domain', () => {
    const plain = render();
    const env = find(plain, 'ConfigMap', 'luno-env').data!;
    expect(env).toMatchObject({ EDGE_ADMIN_URL: 'http://localhost:2019', EDGE_CADDYFILE: '/etc/edge/Caddyfile', EDGE_SITES: '/app/apps/backend/data/caddy/apps', EDGE_LOCAL_PORT: '8000' });
    expect(env.INGRESS_DOMAIN).toBeUndefined();
    expect(plain.some((doc) => doc.kind === 'Service' && doc.metadata.name === 'luno-edge')).toBe(false);
    const caddyfile = find(plain, 'ConfigMap', 'luno-edge').data!.Caddyfile;
    expect(caddyfile).toContain('import /app/apps/backend/data/caddy/apps/*.caddy');
    expect(caddyfile).toContain(':8000 {\n\trespond "No app is exposed at this address on this computer." 404');
    const [backend, edge] = podOf(find(plain, 'Deployment', 'luno-backend')).containers;
    expect(edge?.image).toBe('caddy:2.10.2-alpine');
    expect(edge?.ports).toEqual([{ name: 'edge', containerPort: 8080 }, { name: 'local-apps', containerPort: 8000 }]);
    expect(edge?.volumeMounts).toEqual(expect.arrayContaining([{ name: 'data', mountPath: '/app/apps/backend/data', readOnly: true }]));
    expect(backend?.volumeMounts).toEqual(expect.arrayContaining([{ name: 'edge-config', mountPath: '/etc/edge', readOnly: true }]));
    expect(podOf(find(plain, 'Deployment', 'luno-worker-engine')).containers).toHaveLength(1);

    const docs = render(['routing.domain=koala.dev', 'routing.name=luno', 'edge.nodePort=30321']);
    expect(find(docs, 'ConfigMap', 'luno-env').data).toMatchObject({ INGRESS_DOMAIN: 'koala.dev', INSTANCE_NAME: 'luno' });
    expect(find(docs, 'ConfigMap', 'luno-edge').data!.Caddyfile).toContain('header X-Koala-Edge "luno"');
    expect(specOf(find(docs, 'Service', 'luno-edge'))).toMatchObject({ type: 'NodePort', ports: [{ name: 'edge', port: 80, targetPort: 'edge', nodePort: 30321 }] });
  });

  it('answers for the apps exposed on this computer on its loopback only, through a forwarder of its own that restarts by replacement, so the backend\'s upgrade never waits on the port', () => {
    const docs = render();
    expect(specOf(find(docs, 'Service', 'luno-edge-local'))).toMatchObject({ type: 'ClusterIP', ports: [{ name: 'local-apps', port: 8000, targetPort: 'local-apps' }] });
    const forwarder = find(docs, 'Deployment', 'luno-local-apps');
    expect(specOf(forwarder).strategy).toEqual({ type: 'Recreate' });
    const [forward] = podOf(forwarder).containers;
    expect(forward?.args).toEqual(['caddy', 'reverse-proxy', '--from', ':8000', '--to', 'luno-edge-local.nowrinkles.svc.cluster.local:8000']);
    expect(forward?.ports).toEqual([{ name: 'local-apps', containerPort: 8000, hostPort: 8000, hostIP: '127.0.0.1' }]);
    for (const doc of docs) {
      for (const container of doc.spec?.template?.spec.containers ?? []) {
        if (doc.metadata.name !== 'luno-local-apps') expect((container.ports ?? []).some((port) => typeof port === 'object' && port !== null && 'hostPort' in port), `${doc.metadata.name}/${container.name}`).toBe(false);
      }
    }
    const elsewhere = render(['edge.localPort=8100']);
    expect(find(elsewhere, 'ConfigMap', 'luno-env').data!.EDGE_LOCAL_PORT).toBe('8100');
    expect(podOf(find(elsewhere, 'Deployment', 'luno-local-apps')).containers[0]?.ports).toEqual([{ name: 'local-apps', containerPort: 8100, hostPort: 8100, hostIP: '127.0.0.1' }]);
  });

  it('in the pool, never mounts the machine\'s Docker, and reaches Gitea, Infisical and its registry by the addresses a vcluster has', () => {
    expect(() => render(['pool.enabled=true'])).toThrow(/pool.registryPullHost is required/);
    const docs = render(['pool.enabled=true', 'pool.registryPullHost=127.0.0.1:35010']);
    expect(docs.some((doc) => doc.metadata.name === 'luno-local-apps')).toBe(false);
    expect(find(docs, 'ConfigMap', 'luno-env').data!.EDGE_LOCAL_PORT).toBeUndefined();
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
    expect(podOf(find(docs, 'StatefulSet', 'luno-mongo-stores')).containers[0]!.resources).toEqual({ requests: { memory: '300Mi' } });
    expect(podOf(find(docs, 'StatefulSet', 'luno-temporal-db-stores')).containers[0]!.resources).toEqual({ limits: { memory: '256Mi' } });
    expect(podOf(find(docs, 'Deployment', 'luno-temporal')).containers[0]!.resources).toEqual({ requests: { cpu: '100m' } });
    expect(podOf(find(render(), 'Deployment', 'luno-worker-engine')).containers[0]!.resources).toBeUndefined();
  });
});
