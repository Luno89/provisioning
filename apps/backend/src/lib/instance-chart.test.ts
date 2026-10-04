import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';

const REPO = resolve(__dirname, '../../../..');
const HELM = resolve(REPO, 'bin/helm');
const CHART = resolve(REPO, 'charts/instance');

const required = ['instance.id=inst-u1', 'instance.ownerId=u1', 'instance.rootUrl=https://app.example.com', 'instance.rootPublicKeys=PEM'];

interface Doc {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: any;
  data?: Record<string, string>;
  roleRef?: { name: string };
}

function render(extra: string[] = []): Doc[] {
  const out = execFileSync(HELM, ['template', 'luno', CHART, '--namespace', 'nowrinkles', ...[...required, ...extra].flatMap((value) => ['--set', value])], { encoding: 'utf8' });
  return parseAllDocuments(out).map((doc) => doc.toJSON()).filter(Boolean);
}

const find = (docs: Doc[], kind: string, name: string): Doc => {
  const found = docs.find((doc) => doc.kind === kind && doc.metadata.name === name);
  if (!found) throw new Error(`no ${kind} ${name} in the rendered chart`);
  return found;
};

describe('the instance chart', () => {
  it('runs the backend and all three workers from the one image, each as its own process', () => {
    const docs = render();
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const container = find(docs, 'Deployment', `luno-${process}`).spec.template.spec.containers[0];
      expect(container.image).toBe('nowrinkles/app:dev');
      expect(container.args).toEqual([process]);
    }
  });

  it('configures every process as this owner\'s instance, trusting root and keeping its own keys', () => {
    const docs = render();
    expect(find(docs, 'ConfigMap', 'luno-env').data).toMatchObject({
      ROLE: 'instance', INSTANCE_ID: 'inst-u1', INSTANCE_OWNER_ID: 'u1', ROOT_URL: 'https://app.example.com', ROOT_PUBLIC_KEYS: 'PEM', NODE_ENV: 'production',
    });
    const keys = find(docs, 'Secret', 'luno-keys');
    expect(Object.keys(keys.data ?? {}).sort()).toEqual(['DATA_KEY', 'EGRESS_KEY', 'MONGO_ROOT_PASSWORD', 'PAYLOAD_KEY', 'SESSION_KEY', 'TEMPORAL_DB_PASSWORD']);
    expect(Buffer.from(keys.data!.DATA_KEY!, 'base64').toString().length).toBeGreaterThanOrEqual(32);
    expect(keys.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(Object.keys(keys.data ?? {})).not.toContain('ROOT_IDENTITY_KEY');
  });

  it('runs its own Mongo and Temporal, and points the app at them', () => {
    const docs = render();
    find(docs, 'StatefulSet', 'luno-mongo');
    find(docs, 'StatefulSet', 'luno-temporal-db');
    find(docs, 'Deployment', 'luno-temporal');
    const env = find(docs, 'Deployment', 'luno-backend').spec.template.spec.containers[0].env;
    expect(env.find((entry: { name: string }) => entry.name === 'MONGO_URI').value).toBe('mongodb://admin:$(MONGO_ROOT_PASSWORD)@luno-mongo:27017/provisioning?authSource=admin');
    expect(find(docs, 'ConfigMap', 'luno-env').data!.TEMPORAL_CONNECTION_ADDRESS).toBe('luno-temporal:7233');
  });

  it('owns the cluster it is installed in, and sets up its services there after install and every upgrade', () => {
    const docs = render();
    expect(find(docs, 'ClusterRoleBinding', 'luno-nowrinkles-owns-cluster').roleRef?.name).toBe('cluster-admin');
    for (const step of ['platform-services', 'seed']) {
      const job = find(docs, 'Job', `luno-${step}`);
      expect(job.metadata.annotations?.['helm.sh/hook']).toBe('post-install,post-upgrade');
      expect(job.spec.template.spec.containers[0].args).toEqual([step]);
    }
  });

  it('gives the host worker the machine\'s Docker only when asked, and exposes the backend on a node port only when given one', () => {
    const withDocker = find(render(), 'Deployment', 'luno-worker-host').spec.template.spec.volumes;
    expect(withDocker.map((volume: { name: string }) => volume.name)).toContain('docker-socket');
    const without = find(render(['hostDocker=false']), 'Deployment', 'luno-worker-host').spec.template.spec.volumes;
    expect(without.map((volume: { name: string }) => volume.name)).not.toContain('docker-socket');

    expect(find(render(), 'Service', 'luno').spec.type).toBe('ClusterIP');
    expect(find(render(['backend.nodePort=30320']), 'Service', 'luno').spec).toMatchObject({ type: 'NodePort', ports: [{ nodePort: 30320 }] });
  });

  it('with a credential from root, keeps it in a Secret, hands it to the app, and checks root hourly for the version to run', () => {
    const plain = render();
    expect(plain.find((doc) => doc.kind === 'CronJob')).toBeUndefined();

    const joined = render(['instance.credential=cred-from-root']);
    const secret = find(joined, 'Secret', 'luno-instance') as Doc & { stringData?: Record<string, string> };
    expect(secret.stringData).toEqual({ INSTANCE_CREDENTIAL: 'cred-from-root' });
    expect(secret.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');

    const upgrade = find(joined, 'CronJob', 'luno-self-upgrade').spec;
    expect(upgrade.schedule).toBe('17 * * * *');
    expect(upgrade.concurrencyPolicy).toBe('Forbid');
    const container = upgrade.jobTemplate.spec.template.spec.containers[0];
    expect(container.args).toEqual(['self-upgrade']);
    expect(container.env).toEqual(expect.arrayContaining([{ name: 'CURRENT_IMAGE_TAG', value: 'dev' }, { name: 'RELEASE_NAME', value: 'luno' }]));

    const backend = find(joined, 'Deployment', 'luno-backend').spec.template.spec.containers[0];
    expect(backend.envFrom).toEqual(expect.arrayContaining([{ secretRef: { name: 'luno-instance' } }]));
  });

  it('upgrades each process by starting the new one before stopping the old, and only once it is healthy', () => {
    const docs = render();
    for (const process of ['backend', 'worker-engine', 'worker-cluster', 'worker-host']) {
      const deployment = find(docs, 'Deployment', `luno-${process}`).spec;
      expect(deployment.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
      expect(deployment.template.spec.containers[0].readinessProbe?.httpGet?.path, process).toBe(process === 'backend' ? '/api/auth/sign-in' : '/healthz');
    }
  });

  it('refuses to render without knowing whose instance it is', () => {
    expect(() => execFileSync(HELM, ['template', 'x', CHART], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/instance.id is required/);
  });
});
