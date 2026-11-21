import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { ClusterAccess, InfrastructureService, PLATFORM_PLAN, terraformPlacesFor, type Reach } from '../infrastructure/index.js';
import { INGRESS_WEBHOOK } from '../infrastructure/lib/platform-provision.js';
import { privateCluster, type PrivateCluster } from '../infrastructure/testing/private-cluster.js';
import { CLUSTER_TOOL_PATHS } from '../infrastructure/index.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { CannotRollOut } from './watched-apply.js';
import { provisionPlatformService, type PlatformPlace } from './platform-provision.js';

const PROXY_MANIFEST = resolve(import.meta.dirname, '../../../../k8s/koala-egress/egress-proxy.yaml');
const service = (key: string) => PLATFORM_PLAN.find((each) => each.key === key)!;
const quickly = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, Math.min(ms, 500)); });

let k3s: PrivateCluster;
let access: ClusterAccess;
let own: Reach;
let place: PlatformPlace;
let infra: InfrastructureService;

beforeAll(async () => {
  k3s = await privateCluster(import.meta.filename);
  access = new ClusterAccess({
    here: { koalaMachineId: 'desk', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-platform-')),
    processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account,
  });
  own = access.own();
  const dataDir = testDataDir();
  mkdirSync(dataDir, { recursive: true });
  place = { reach: own, koalaNamespace: 'nowrinkles', pool: false, dataDir, crawl4aiToken: 'crawlToken40', qdrantApiKey: 'qdrantKey40' };
  infra = new InfrastructureService(terraformPlacesFor({ kind: 'local' }, dataDir));
}, 0);

afterAll(async () => { await k3s?.stop(); }, 0);

describe('Koala\'s platform services applied as stacks on a real cluster', () => {
  it('takes over the egress proxy an older install applied by hand, keeps the grants Koala wrote, and brings it up with its rules stamped', async () => {
    await access.kubectl(own, ['create', 'namespace', 'koala-egress']);
    await access.kubectl(own, ['create', 'configmap', 'egress-grants', '-n', 'koala-egress', '--from-literal=passwd=', '--from-literal=acls.conf=# granted by Koala']);
    await access.apply(own, readFileSync(PROXY_MANIFEST, 'utf8'));
    const told: string[] = [];

    await provisionPlatformService({ access, infra }, place, service('egress'), (line) => told.push(line), quickly);

    expect(told.at(-1)).toBe('the egress proxy: ready');
    expect(await access.kubectl(own, ['get', 'configmap', 'egress-grants', '-n', 'koala-egress', '-o', 'jsonpath={.data.acls\\.conf}'])).toBe('# granted by Koala');
    expect(await access.kubectl(own, ['get', 'deployment', 'egress-proxy', '-n', 'koala-egress', '-o', 'jsonpath={.status.availableReplicas}'])).toBe('1');
    expect(await access.kubectl(own, ['get', 'deployment', 'egress-proxy', '-n', 'koala-egress', '-o', 'jsonpath={.spec.template.metadata.annotations.koala\\.dev/egress-config}'])).toMatch(/^[0-9a-f]{16}$/);

    await provisionPlatformService({ access, infra }, place, service('egress'), () => undefined, quickly);
    expect(await access.kubectl(own, ['get', 'configmap', 'egress-grants', '-n', 'koala-egress', '-o', 'jsonpath={.data.acls\\.conf}'])).toBe('# granted by Koala');
  }, 0);

  it('stops the moment a service can never start, saying which workload and why', async () => {
    await access.kubectl(own, ['create', 'namespace', 'searxng']);
    await access.kubectl(own, ['create', 'quota', 'none', '-n', 'searxng', '--hard=pods=0']);

    const failed = await provisionPlatformService({ access, infra }, place, service('searxng'), () => undefined, quickly).then(() => undefined, (err: unknown) => err);

    expect(failed, `the apply ended otherwise: ${String((failed as Error | undefined)?.message ?? failed)}`).toBeInstanceOf(CannotRollOut);
    expect((failed as CannotRollOut).what).toBe('SearXNG');
    expect((failed as CannotRollOut).why).toMatch(/^searxng cannot make its pods: .*exceeded quota/);
    expect(await access.kubectl(own, ['get', 'secret', 'searxng-secret', '-n', 'searxng', '-o', 'name'])).toBe('secret/searxng-secret\n');
  }, 0);

  it('refuses Infisical while an ingress webhook with no certificate authority refuses every Ingress, saying how to remove it, and applies nothing', async () => {
    await access.apply(own, JSON.stringify({
      apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingWebhookConfiguration', metadata: { name: INGRESS_WEBHOOK },
      webhooks: [{
        name: 'validate.nginx.ingress.kubernetes.io', admissionReviewVersions: ['v1'], sideEffects: 'None', failurePolicy: 'Fail',
        clientConfig: { service: { name: 'infisical-ingress-nginx-controller-admission', namespace: 'infisical', path: '/networking/v1/ingresses' } },
        rules: [{ apiGroups: ['networking.k8s.io'], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['ingresses'] }],
      }],
    }));

    const failed = await provisionPlatformService({ access, infra }, place, service('infisical'), () => undefined, quickly).then(() => undefined, (err: unknown) => err);

    expect((failed as Error | undefined)?.message).toBe(`Infisical cannot be applied: the webhook ${INGRESS_WEBHOOK} has no certificate authority, so every Ingress on the cluster is refused and no app can deploy; remove it with: kubectl delete validatingwebhookconfiguration ${INGRESS_WEBHOOK}`);
    expect(await access.kubectl(own, ['get', 'namespaces', '-o', 'name'])).not.toContain('namespace/infisical');
  }, 0);
});
