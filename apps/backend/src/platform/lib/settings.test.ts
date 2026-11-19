import { testIdentityKey, testKeyEnv } from '../testing/keys.js';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  backendSettingsFrom, clusterWorkerSettingsFrom, engineWorkerSettingsFrom, hostWorkerSettingsFrom, moveImportSettingsFrom, operatorCredentialsFrom,
  platformServicesSettingsFrom, selfUpgradeSettingsFrom, SettingsError,
} from './settings.js';

const saying = (text: string): unknown => expect.stringContaining(text);
const ANY_TEXT: unknown = expect.any(String);

const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');

const CONNECTION = {
  ...testKeyEnv('settings'),
  ROOT_IDENTITY_KEY: testIdentityKey(),
  MONGO_URI: 'mongodb://admin:admin@127.0.0.1:27017/provisioning?authSource=admin',
  TEMPORAL_CONNECTION_ADDRESS: '127.0.0.1:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TLS_CA: '/etc/koala/temporal-tls/ca.crt',
  DATA_DIR: '/app/apps/backend/data',
};

const BACKEND = { ...CONNECTION, PORT: '3001', PUBLIC_URL: 'https://luno.koala.app/', APP_URL: 'https://luno.koala.app', TRUST_PROXY: '1' };

const ROOT = { ...BACKEND, ROLE: 'root', TERRAFORM_STATE: 'local', INSTANCE_IMAGE_TAG: 'a1b2c3d4e5f6', INSTANCE_REGISTRY: '100.64.0.1:5001' };

const TENANT = {
  GITEA_URL: 'http://gitea-http.gitea.svc.cluster.local:3000', GITEA_REACHES_KOALA_AT: 'http://instance.nowrinkles.svc.cluster.local',
  INFISICAL_URL: 'http://infisical.infisical.svc.cluster.local:8080',
  MINIO_ENDPOINT: 'instance-minio:9000', MINIO_ROOT_USER: 'koala', MINIO_ROOT_PASSWORD: 'minio-secret', MINIO_BUCKET: 'koala',
  KOALA_REGISTRY: '127.0.0.1:31737', KOALA_REGISTRY_PUSH: 'gitea-http.gitea.svc.cluster.local:3000', REGISTRY_PULL_HOST: '127.0.0.1:31737',
  SEARXNG_URL: 'http://searxng.searxng.svc.cluster.local:8080', CRAWL4AI_URL: 'http://crawl4ai.crawl4ai.svc.cluster.local:11235', CRAWL4AI_API_TOKEN: 'crawl-token',
  CHECKS_API_URL: 'http://instance.nowrinkles.svc.cluster.local/api',
};

const INSTANCE = {
  ...BACKEND, ...TENANT, ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'https://app.koala.dev', ROOT_PUBLIC_KEYS: rootKey,
  INSTANCE_CREDENTIAL: 'cred', INSTANCE_MACHINE_ID: 'desk', MACHINE_GATEWAY_PORT: '7234', TERRAFORM_STATE: 'local', KOALA_RELEASE_REVISION: '7',
};

const HUB = { ...BACKEND, ROLE: 'hub', ROOT_URL: 'https://app.koala.dev', ROOT_PUBLIC_KEYS: rootKey, HUB_CREDENTIAL: 'hub-cred', HUB_DATABASE: 'koala_hub', GITEA_URL: TENANT.GITEA_URL, GITEA_REACHES_KOALA_AT: 'http://hub.koala.dev' };

const WORKER = { HEALTH_PORT: '8090', TEMPORAL_METRICS_PORT: '9464' };

const problemsOf = (read: () => unknown): string[] => {
  try {
    read();
  } catch (err) {
    if (err instanceof SettingsError) return [...err.problems];
    throw err;
  }
  throw new Error('the settings were taken');
};

describe('the settings a backend reads once, at start', () => {
  it('takes root\'s, with every feature it was not given off and saying why', () => {
    const settings = backendSettingsFrom(ROOT);
    expect(settings).toMatchObject({ koalaProcess: 'backend', port: 3001, publicUrl: 'https://luno.koala.app', production: false, temporal: { address: '127.0.0.1:7233', namespace: 'default', caPath: '/etc/koala/temporal-tls/ca.crt' }, terraform: { kind: 'local' }, dataDir: '/app/apps/backend/data' });
    expect(settings.root).toMatchObject({ imageTag: 'a1b2c3d4e5f6', registry: '100.64.0.1:5001', routing: { off: saying('INGRESS_DOMAIN') }, pool: { off: ANY_TEXT } });
    expect(settings.mesh).toEqual({ off: 'MESH_LOGIN_SERVER is not set, so machines and instances join no mesh' });
    expect(settings.metricsToken).toEqual({ off: 'METRICS_TOKEN is not set, so /api/metrics serves nothing' });
    expect(settings.twilio).toMatchObject({ off: saying('Twilio') });
    expect(settings.operator.googleDrive).toMatchObject({ off: saying('GOOGLE_CLIENT_ID') });
    expect(settings.operator.ovhSubsidiary).toMatchObject({ off: saying('OVH_SUBSIDIARY') });
    expect(settings.mail).toEqual({ kind: 'none', why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' });
    expect(settings.tenant).toBeUndefined();
    expect(settings.instance).toBeUndefined();
  });

  it('stops naming every setting root lacks or holds malformed, all at once', () => {
    const problems = problemsOf(() => backendSettingsFrom({ ROLE: 'root', ...testKeyEnv('settings'), ROOT_IDENTITY_KEY: CONNECTION.ROOT_IDENTITY_KEY, PORT: 'eighty', TEMPORAL_CONNECTION_ADDRESS: 'http://localhost:7233' }));
    for (const name of ['MONGO_URI', 'TEMPORAL_NAMESPACE', 'TEMPORAL_TLS_CA', 'DATA_DIR', 'PUBLIC_URL', 'APP_URL', 'TERRAFORM_STATE', 'INSTANCE_IMAGE_TAG', 'INSTANCE_REGISTRY']) {
      expect(problems.some((problem) => problem.includes(name)), name).toBe(true);
    }
    expect(problems).toContain('PORT is not a port: eighty');
    expect(problemsOf(() => backendSettingsFrom({ ...ROOT, DATA_DIR: 'data' }))).toContain('DATA_DIR is not an absolute path: data');
    expect(problems).toContain('TEMPORAL_CONNECTION_ADDRESS is not a host and port: http://localhost:7233');
    expect(() => backendSettingsFrom({})).toThrow(/the backend cannot start; its settings are not right:\n {2}- ROLE is not set/);
  });

  it('trust proxy comes from the setting, and a missing one is refused', () => {
    expect(backendSettingsFrom(ROOT).trustProxy).toBe(1);
    expect(backendSettingsFrom({ ...ROOT, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(backendSettingsFrom({ ...ROOT, NODE_ENV: 'production', TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    const { TRUST_PROXY: _left, ...without } = ROOT;
    expect(problemsOf(() => backendSettingsFrom(without))).toContainEqual(saying('TRUST_PROXY is not set'));
    expect(problemsOf(() => backendSettingsFrom({ ...ROOT, TRUST_PROXY: 'true' }))).toContainEqual(saying('TRUST_PROXY is "true"'));
  });

  it('guesses no address: root routing instances needs its Caddy named, and the mesh needs Headscale', () => {
    const problems = problemsOf(() => backendSettingsFrom({ ...ROOT, INGRESS_DOMAIN: 'nowrinkles.app', MESH_LOGIN_SERVER: 'https://mesh.koala.dev' }));
    for (const name of ['CADDY_ADMIN_SOCKET', 'CADDY_CONFIG', 'CADDY_LOG', 'CADDY_TLS_ADDRESS', 'HEADSCALE_URL']) expect(problems.some((problem) => problem.startsWith(`${name} is not set`)), name).toBe(true);
    const routed = backendSettingsFrom({ ...ROOT, INGRESS_DOMAIN: 'nowrinkles.app', APP_DOMAIN: 'app.koala.dev', CADDY_ADMIN_SOCKET: '/run/koala-caddy/admin.sock', CADDY_CONFIG: '/opt/nowrinkles/Caddyfile', CADDY_LOG: '/var/log/koala-caddy/caddy.log', CADDY_TLS_ADDRESS: '127.0.0.1:443' });
    expect(routed.root?.routing).toEqual({ domain: 'nowrinkles.app', caddy: { adminSocket: '/run/koala-caddy/admin.sock', config: '/opt/nowrinkles/Caddyfile', log: '/var/log/koala-caddy/caddy.log', tlsAddress: '127.0.0.1:443' }, siteDomains: ['app.koala.dev'] });
    expect(routed.reach).toMatchObject({ domain: 'nowrinkles.app', ownCaddy: { host: '127.0.0.1', port: 443 } });
  });

  it('sends mail from a named address only, never from a guessed domain', () => {
    expect(problemsOf(() => backendSettingsFrom({ ...ROOT, MAIL_SMTP_URL: 'smtp://127.0.0.1:2525' }))).toContain('MAIL_SMTP_URL is set, but neither MAIL_FROM nor DOMAIN is, so mail would go out from no address of this platform\'s');
    expect(backendSettingsFrom({ ...ROOT, MAIL_SMTP_URL: 'smtp://127.0.0.1:2525', DOMAIN: 'koala.dev' }).mail).toEqual({ kind: 'smtp', url: 'smtp://127.0.0.1:2525', from: 'Koala <alerts@koala.dev>' });
  });

  it('refuses half of a feature: a pool without its slot\'s size, half of Twilio, half of Google Drive, OVHcloud keys without their subsidiary', () => {
    const pool = { INGRESS_DOMAIN: 'nowrinkles.app', CADDY_ADMIN_SOCKET: '/s', CADDY_CONFIG: '/c', CADDY_LOG: '/l', CADDY_TLS_ADDRESS: '127.0.0.1:443', POOL_ADDRESS: '100.64.0.1', POOL_KUBECONFIG: '/k', POOL_SLOTS: '2', POOL_SLOT_MEMORY_MIB: '10240' };
    const problems = problemsOf(() => backendSettingsFrom({ ...ROOT, ...pool, TWILIO_ACCOUNT_SID: 'sid', GOOGLE_CLIENT_ID: 'id', OVH_APPLICATION_KEY: 'k', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c' }));
    expect(problems).toContain('POOL_SLOT_CPU is not set, and a pool slot needs it');
    expect(problems.some((problem) => problem.startsWith('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER go together'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('OVH_SUBSIDIARY is not set beside the operator\'s OVHcloud keys'))).toBe(true);
    const full = backendSettingsFrom({ ...ROOT, ...pool, POOL_SLOT_CPU: '4', POOL_SLOT_STORAGE_GIB: '100', POOL_TRIAL_DAYS: '14' });
    expect(full.root?.pool).toMatchObject({ slots: 2, slot: { memoryMiB: 10240, cpu: 4, storageGiB: 100 }, image: { repository: '100.64.0.1:5001/nowrinkles/app', tag: 'a1b2c3d4e5f6' }, trialDays: 14 });
  });

  it('takes an instance\'s, with the services the chart names and nothing guessed for the ones it does not', () => {
    const settings = backendSettingsFrom(INSTANCE);
    expect(settings.tenant).toMatchObject({ checksApi: 'http://instance.nowrinkles.svc.cluster.local/api', registryPullHost: '127.0.0.1:31737', webTools: { searxngUrl: TENANT.SEARXNG_URL, crawl4aiUrl: TENANT.CRAWL4AI_URL, crawl4aiToken: 'crawl-token' } });
    expect(settings.instance).toMatchObject({ credential: 'cred', gatewayPort: 7234, revision: 7, edge: { off: saying('no edge') }, selfUpgrade: { off: ANY_TEXT }, machineTemporalAddress: { off: saying('MACHINE_TEMPORAL_ADDRESS') }, poolMonitor: { off: ANY_TEXT } });
    expect(settings.endpointRules).toEqual({ scriptedBase: 'http://instance.nowrinkles.svc.cluster.local/api/checks/scripted', lab: false });
    expect(settings.clusters.here).toEqual({ koalaMachineId: 'desk', root: false });
    expect(settings.mesh).toEqual({ off: 'instance runs no mesh; root does' });
    const missing = problemsOf(() => backendSettingsFrom({ ...INSTANCE, MINIO_BUCKET: '', SEARXNG_URL: '', CRAWL4AI_API_TOKEN: '', CHECKS_API_URL: '', INSTANCE_CREDENTIAL: '', MACHINE_GATEWAY_PORT: '' }));
    for (const name of ['MINIO_BUCKET', 'SEARXNG_URL', 'CRAWL4AI_API_TOKEN', 'CHECKS_API_URL', 'INSTANCE_CREDENTIAL', 'MACHINE_GATEWAY_PORT']) expect(missing.some((problem) => problem.includes(name)), name).toBe(true);
  });

  it('takes the chart revision an instance runs, a whole number from 1, and stops without one', () => {
    expect(problemsOf(() => backendSettingsFrom({ ...INSTANCE, KOALA_RELEASE_REVISION: '' })).some((problem) => problem.startsWith('KOALA_RELEASE_REVISION is not set'))).toBe(true);
    for (const wrong of ['0', '-2', '1.5', 'seven']) expect(problemsOf(() => backendSettingsFrom({ ...INSTANCE, KOALA_RELEASE_REVISION: wrong })), wrong).toContain(`KOALA_RELEASE_REVISION is not a chart revision, a whole number from 1: ${wrong}`);
    expect(backendSettingsFrom({ ...INSTANCE, KOALA_RELEASE_REVISION: '12' }).instance?.revision).toBe(12);
  });

  it('takes an instance with no machine named as one with no cluster of its own, and a trial on Koala\'s servers only with its name', () => {
    expect(backendSettingsFrom({ ...INSTANCE, INSTANCE_MACHINE_ID: '' }).clusters.here).toEqual({ koalaMachineId: undefined, poolName: undefined, root: false });
    expect(problemsOf(() => backendSettingsFrom({ ...INSTANCE, POOL: 'true' }))).toContain('INSTANCE_NAME is not set: a trial instance on Koala\'s servers is named by it');
    expect(problemsOf(() => backendSettingsFrom({ ...INSTANCE, POOL: 'yes' }))).toContain('POOL is "yes"; it is "true" on a trial instance on Koala\'s servers and unset anywhere else');
    expect(backendSettingsFrom({ ...INSTANCE, POOL: 'true', INSTANCE_NAME: 'bob' }).instance?.poolMonitor).toEqual({ rootUrl: 'https://app.koala.dev', instanceId: 'inst-1' });
  });

  it('takes the hub\'s, its registry database named rather than guessed', () => {
    expect(backendSettingsFrom(HUB)).toMatchObject({ hubDatabase: 'koala_hub', hubGitea: { url: TENANT.GITEA_URL }, terraform: { off: 'the hub runs no Terraform' } });
    expect(problemsOf(() => backendSettingsFrom({ ...HUB, HUB_DATABASE: '' }))).toContain('HUB_DATABASE is not set: it is the database the hub keeps its registry of shared projects in');
  });

  it('takes no queue names from the environment, which name where work runs in one place, and keeps test parameters at the product\'s value unless a suite shortens them', () => {
    expect(backendSettingsFrom(ROOT)).toMatchObject({ tests: { unreachableAfterMs: 600_000, openRouterUrl: 'https://openrouter.ai' } });
    const named = backendSettingsFrom({ ...ROOT, POOL_TASK_QUEUE: 'suite-queue', TEMPORAL_TASK_QUEUE: 'q', TEMPORAL_ENGINE_TASK_QUEUE: 'q', WATCH_UNREACHABLE_MINUTES: '1' });
    expect('queues' in named).toBe(false);
    expect(named).toMatchObject({ tests: { unreachableAfterMs: 60_000 } });
    expect(problemsOf(() => backendSettingsFrom({ ...ROOT, WATCH_UNREACHABLE_MINUTES: 'soon' }))).toContain('WATCH_UNREACHABLE_MINUTES is not a number of minutes: soon');
    expect(backendSettingsFrom(ROOT).tests.dependencySources).toEqual({ osv: 'https://api.osv.dev/v1', npm: 'https://registry.npmjs.org', github: 'https://api.github.com', ghcr: 'https://ghcr.io', dockerHub: 'https://registry-1.docker.io', dockerAuth: 'https://auth.docker.io' });
    expect(backendSettingsFrom({ ...ROOT, DEPENDENCY_SOURCES: 'http://127.0.0.1:4100/' }).tests.dependencySources).toEqual({ osv: 'http://127.0.0.1:4100/osv', npm: 'http://127.0.0.1:4100/npm', github: 'http://127.0.0.1:4100/github', ghcr: 'http://127.0.0.1:4100/ghcr', dockerHub: 'http://127.0.0.1:4100/docker-hub', dockerAuth: 'http://127.0.0.1:4100/docker-auth' });
    expect(problemsOf(() => backendSettingsFrom({ ...ROOT, DEPENDENCY_SOURCES: 'somewhere' })).some((problem) => problem.includes('DEPENDENCY_SOURCES'))).toBe(true);
    expect(backendSettingsFrom(ROOT).clusters.chartSources).toBeUndefined();
    expect(backendSettingsFrom({ ...ROOT, CHART_SOURCES: 'http://127.0.0.1:4100' }).clusters.chartSources).toBe('http://127.0.0.1:4100');
    expect(problemsOf(() => backendSettingsFrom({ ...ROOT, CHART_SOURCES: 'somewhere' })).some((problem) => problem.includes('CHART_SOURCES'))).toBe(true);
  });
});

describe('the settings each worker reads once, at start', () => {
  it('asks every worker for its health and metrics ports, 0 meaning none', () => {
    expect(hostWorkerSettingsFrom({ ...ROOT, HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '9465' })).toMatchObject({ healthPort: 0, temporalMetricsPort: 9465, publicUrl: 'https://luno.koala.app', root: { imageTag: 'a1b2c3d4e5f6' } });
    const problems = problemsOf(() => hostWorkerSettingsFrom(ROOT));
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/^HEALTH_PORT is not set/), expect.stringMatching(/^TEMPORAL_METRICS_PORT is not set/)]));
    expect(problemsOf(() => hostWorkerSettingsFrom({ ...ROOT, ...WORKER, HEALTH_PORT: 'any' }))).toContain('HEALTH_PORT is not a port: any');
  });

  it('asks an instance\'s host worker for nothing of root\'s', () => {
    expect(hostWorkerSettingsFrom({ ...CONNECTION, ...WORKER, ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'https://app.koala.dev', ROOT_PUBLIC_KEYS: rootKey, SEARXNG_URL: TENANT.SEARXNG_URL, CRAWL4AI_URL: TENANT.CRAWL4AI_URL, CRAWL4AI_API_TOKEN: TENANT.CRAWL4AI_API_TOKEN })).toMatchObject({ root: undefined, publicUrl: undefined, mesh: { off: ANY_TEXT } });
  });

  it('gives the cluster worker its services, its Terraform and the address machines send metrics to, or why there is none', () => {
    const env = { ...INSTANCE, ...WORKER, POD_NAMESPACE: 'nowrinkles', CRAWL4AI_API_TOKEN: 'crawlToken40' };
    expect(clusterWorkerSettingsFrom(env)).toMatchObject({ gitea: { url: TENANT.GITEA_URL }, terraform: { kind: 'local' }, registryPullHost: '127.0.0.1:31737', machineMetricsUrl: { off: saying('MACHINE_METRICS_URL') } });
    expect(clusterWorkerSettingsFrom({ ...env, MACHINE_METRICS_URL: 'http://100.64.0.7:30320/api/machines/metrics' }).machineMetricsUrl).toBe('http://100.64.0.7:30320/api/machines/metrics');
    expect(problemsOf(() => clusterWorkerSettingsFrom({ ...env, TERRAFORM_STATE: '' }))).toContain('TERRAFORM_STATE is not set: it says where Terraform keeps each stack\'s state, local (in the data folder) or kubernetes (in this pod\'s namespace)');
  });

  it('gives the cluster worker what Koala\'s own setup applies with: its namespace and Crawl4AI\'s token, and refuses a token the chart never makes', () => {
    const env = { ...INSTANCE, ...WORKER, POD_NAMESPACE: 'nowrinkles', CRAWL4AI_API_TOKEN: 'crawlToken40' };
    expect(clusterWorkerSettingsFrom(env)).toMatchObject({ podNamespace: 'nowrinkles', crawl4aiToken: 'crawlToken40', dataDir: '/app/apps/backend/data' });
    expect(problemsOf(() => clusterWorkerSettingsFrom({ ...env, CRAWL4AI_API_TOKEN: '' }))).toContain('CRAWL4AI_API_TOKEN is not set: Crawl4AI reads pages only for a caller holding it, and the instance chart makes it');
    expect(problemsOf(() => clusterWorkerSettingsFrom({ ...env, CRAWL4AI_API_TOKEN: 'a b' }))).toContain('CRAWL4AI_API_TOKEN holds more than letters and digits, which the instance chart never makes');
    expect(problemsOf(() => clusterWorkerSettingsFrom({ ...env, POD_NAMESPACE: '' }))).toContain('POD_NAMESPACE is not set: it is this instance\'s own namespace, which the platform services answer and where Terraform keeps their state');
  });

  it('gives the cluster worker whose Koala it asks to set up a cluster, and the chart revision the setup is for', () => {
    const env = { ...INSTANCE, ...WORKER, POD_NAMESPACE: 'nowrinkles', CRAWL4AI_API_TOKEN: 'crawlToken40' };
    expect(clusterWorkerSettingsFrom(env).koala).toEqual({ ownerId: 'owner-1', revision: 7 });
    expect(problemsOf(() => clusterWorkerSettingsFrom({ ...env, KOALA_RELEASE_REVISION: '' })).some((problem) => problem.startsWith('KOALA_RELEASE_REVISION is not set'))).toBe(true);
    expect(problemsOf(() => clusterWorkerSettingsFrom({ ...env, KOALA_RELEASE_REVISION: 'seven' }))).toContain('KOALA_RELEASE_REVISION is not a chart revision, a whole number from 1: seven');
  });

  it('runs the engine worker only in an instance, with everything its runs reach', () => {
    const env = { ...INSTANCE, HEALTH_PORT: '8090', TEMPORAL_ENGINE_METRICS_PORT: '9467' };
    expect(engineWorkerSettingsFrom(env)).toMatchObject({ temporalMetricsPort: 9467, instanceCredential: 'cred', tenant: { checksApi: TENANT.CHECKS_API_URL } });
    expect(problemsOf(() => engineWorkerSettingsFrom({ ...env, ...ROOT, ...WORKER, TEMPORAL_ENGINE_METRICS_PORT: '9467' }))).toContain('the engine worker runs only in an instance, and ROLE is root');
  });
});

describe('the settings of a step run in an instance\'s pod', () => {
  it('gives the self-upgrade the release it upgrades and root to ask, and refuses one that is not named', () => {
    const env = { ...INSTANCE, RELEASE_NAME: 'instance', RELEASE_NAMESPACE: 'nowrinkles', CURRENT_IMAGE_TAG: 'a1b2c3d4e5f6', DATA_VERSION: '1' };
    expect(selfUpgradeSettingsFrom(env)).toMatchObject({ root: { url: 'https://app.koala.dev', instanceId: 'inst-1', credential: 'cred' }, release: { name: 'instance', namespace: 'nowrinkles', current: 'a1b2c3d4e5f6', dataVersion: 1 } });
    expect(problemsOf(() => selfUpgradeSettingsFrom({ ...env, DATA_VERSION: '' }))).toContain('DATA_VERSION is not set: it is the data version the installed release brought, below which this instance never moves');
    expect(problemsOf(() => selfUpgradeSettingsFrom({ ...env, DATA_VERSION: 'one' }))).toContain('DATA_VERSION is one, not a whole number');
    expect(problemsOf(() => selfUpgradeSettingsFrom({ ...env, RELEASE_NAME: '' }))).toContain('RELEASE_NAME is not set: the self-upgrade CronJob names the release it upgrades');
  });

  it('gives the move its root, Mongo, Gitea and namespace, and refuses one without its namespace', () => {
    expect(moveImportSettingsFrom({ ...INSTANCE, POD_NAMESPACE: 'nowrinkles' })).toMatchObject({ rootUrl: 'https://app.koala.dev', instanceId: 'inst-1', credential: 'cred', podNamespace: 'nowrinkles', registryPullHost: '127.0.0.1:31737', dataDir: '/app/apps/backend/data' });
    expect(problemsOf(() => moveImportSettingsFrom(INSTANCE))).toContain('POD_NAMESPACE is not set: it is this instance\'s own namespace, where Terraform keeps its state');
  });

  it('gives the platform services step its cluster, its namespace, its data folder and Crawl4AI\'s token, and refuses a token the chart never makes', () => {
    const env = { ...INSTANCE, POD_NAMESPACE: 'nowrinkles', TERRAFORM_STATE: 'kubernetes', KUBERNETES_SERVICE_HOST: '10.43.0.1', CRAWL4AI_API_TOKEN: 'crawlToken40' };
    expect(platformServicesSettingsFrom(env)).toMatchObject({ podNamespace: 'nowrinkles', dataDir: '/app/apps/backend/data', terraform: { kind: 'kubernetes', namespace: 'nowrinkles' }, crawl4aiToken: 'crawlToken40', clusters: { here: { koalaMachineId: 'desk' } } });
    expect(problemsOf(() => platformServicesSettingsFrom({ ...env, CRAWL4AI_API_TOKEN: '' }))).toContain('CRAWL4AI_API_TOKEN is not set: Crawl4AI reads pages only for a caller holding it, and the instance chart makes it');
    expect(problemsOf(() => platformServicesSettingsFrom({ ...env, CRAWL4AI_API_TOKEN: 'a b' }))).toContain('CRAWL4AI_API_TOKEN holds more than letters and digits, which the instance chart never makes');
    expect(problemsOf(() => platformServicesSettingsFrom({ ...env, POD_NAMESPACE: '' }))).toContain('POD_NAMESPACE is not set: it is this instance\'s own namespace, which the platform services answer and where Terraform keeps their state');
  });
});

describe('the operator\'s own credentials', () => {
  it('hands on only the names Koala resolves credentials from', () => {
    expect(operatorCredentialsFrom({ OVH_APPLICATION_KEY: 'k', OVH_SUBSIDIARY: 'FR', PORKBUN_API_KEY: 'pk', SESSION_KEY: 'never' }).env).toEqual({ OVH_APPLICATION_KEY: 'k', OVH_SUBSIDIARY: 'FR', PORKBUN_API_KEY: 'pk' });
  });

  it('takes no Hugging Face or GitHub token from the environment', () => {
    expect(operatorCredentialsFrom({ HF_TOKEN: 'hf', VLLM_HF_TOKEN: 'hf', HUGGING_FACE_HUB_TOKEN: 'hf', GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh' }).env).toEqual({});
  });
});
