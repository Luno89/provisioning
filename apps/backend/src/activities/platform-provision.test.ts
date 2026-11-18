import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess, InfrastructureService, Reach } from '../infrastructure/index.js';
import { ROLLOUT_KINDS } from '../infrastructure/lib/rollout.js';
import { CannotRollOut } from './watched-apply.js';
import { provisionPlatformServices } from './platform-provision.js';

const OWN: Reach = { clusterId: 'machine-desk', kind: 'koala' };
const now = (): Promise<void> => Promise.resolve();

const refused = (namespace: string) => [
  { kind: 'Deployment', metadata: { name: namespace, namespace, generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'ReplicaFailure', status: 'True', message: 'pods "x" is forbidden: exceeded quota: none' }] } },
];

interface Seen { hopeless?: string; webhook?: unknown; already?: { namespaces?: string[]; objects?: Record<string, unknown[]>; releases?: Record<string, unknown[]> } }

function cluster(seen: Seen = {}) {
  const access = mock<ClusterAccess>();
  const order: string[] = [];
  access.kubectl.mockImplementation(async (_target, args) => {
    if (args[0] === 'get' && args[1] === ROLLOUT_KINDS) return JSON.stringify({ items: args[3] === seen.hopeless ? refused(args[3]!) : [] });
    if (args[0] === 'get' && args[1] === 'namespaces') return JSON.stringify({ items: (seen.already?.namespaces ?? []).map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } })) });
    if (args[0] === 'get' && args[1] === 'validatingwebhookconfigurations') return JSON.stringify(seen.webhook ?? { items: [] });
    if (args[0] === 'get') return JSON.stringify({ items: seen.already?.objects?.[args[3]!] ?? [] });
    return '';
  });
  access.helm.mockImplementation(async (_target, args) => JSON.stringify(seen.already?.releases?.[args[2]!] ?? []));
  access.apply.mockImplementation(async (_target, manifest) => {
    const made = JSON.parse(manifest) as { kind: string; metadata: { name: string } };
    order.push(`apply ${made.kind}/${made.metadata.name}`);
    return '';
  });
  access.kubeconfigOf.mockResolvedValue('/clusters/kubeconfig-koala');
  const infra = mock<InfrastructureService>();
  infra.getLogPath.mockImplementation((id) => `/data/logs/${id}.log`);
  infra.deploy.mockImplementation(async (stack, options) => {
    order.push(`deploy ${stack}`);
    if (options?.env?.PLATFORM_SERVICE === seen.hopeless) {
      await new Promise<void>((_done, failed) => { options?.signal?.addEventListener('abort', () => failed(new Error('stopped'))); });
    }
    return { stdout: '', logFile: '' };
  });
  return { steps: { access, infra }, order };
}

const place = (dataDir = mkdtempSync(join(tmpdir(), 'koala-platform-'))) => ({ reach: OWN, koalaNamespace: 'nowrinkles', pool: false, dataDir, crawl4aiToken: 'crawlToken40' });

describe('putting Koala\'s platform services on the cluster it runs in', () => {
  it('applies each service\'s stack in order, its Secrets made first, saying as each starts and is ready', async () => {
    const { steps, order } = cluster();
    const told: string[] = [];
    await provisionPlatformServices(steps, place(), (line) => told.push(line), now);
    expect(order.filter((line) => line.startsWith('deploy'))).toEqual(['deploy platform-egress', 'deploy platform-searxng', 'deploy platform-crawl4ai', 'deploy platform-gitea', 'deploy platform-verdaccio', 'deploy platform-infisical']);
    expect(order.indexOf('apply Secret/gitea-admin')).toBeLessThan(order.indexOf('deploy platform-gitea'));
    expect(order.indexOf('apply Namespace/gitea')).toBeLessThan(order.indexOf('apply Secret/gitea-admin'));
    expect(order.indexOf('apply Secret/infisical-store-passwords')).toBeLessThan(order.indexOf('deploy platform-infisical'));
    expect(told).toContain('Gitea: applying; Terraform writes to /data/logs/platform-gitea.log');
    expect(told).toContain('Gitea: ready');
    expect(told.indexOf('the egress proxy: ready')).toBeLessThan(told.indexOf('SearXNG: applying; Terraform writes to /data/logs/platform-searxng.log'));
  });

  it('hands each stack what is already on the cluster, how to reach it and whose it is, and never a secret', async () => {
    const { steps } = cluster({ already: { namespaces: ['gitea', 'kube-system'], releases: { gitea: [{ name: 'gitea', namespace: 'gitea', status: 'deployed', chart: 'gitea-12.7.0' }] } } });
    await provisionPlatformServices(steps, place(), () => undefined, now);
    const gitea = steps.infra.deploy.mock.calls.find(([stack]) => stack === 'platform-gitea')![1]!;
    expect(gitea.env).toMatchObject({ STACK_TYPE: 'platform', PLATFORM_SERVICE: 'gitea', KUBECONFIG_PATH: '/clusters/kubeconfig-koala', KOALA_NAMESPACE: 'nowrinkles', POOL: 'false', SECRET_STAMP: expect.stringMatching(/^[0-9a-f]{16}$/) as unknown });
    expect(JSON.parse(gitea.env!.PLATFORM_EXISTING!)).toEqual(['v1/Namespace//gitea', 'helm/gitea/gitea']);
    const secrets = steps.access.apply.mock.calls.map(([, manifest]) => JSON.parse(manifest) as { kind: string; stringData?: Record<string, string> }).filter((made) => made.kind === 'Secret');
    const values = secrets.flatMap((secret) => Object.values(secret.stringData ?? {})).filter((value) => value.length >= 12);
    expect(values.length).toBeGreaterThan(5);
    for (const value of values) expect(JSON.stringify(steps.infra.deploy.mock.calls)).not.toContain(value);
  });

  it('makes each secret it keeps once, in the data folder only it reads, and keeps it on every run after', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'koala-platform-'));
    writeFileSync(join(dataDir, '.gitea-admin-password'), 'kept-from-before\n');
    const first = cluster();
    await provisionPlatformServices(first.steps, place(dataDir), () => undefined, now);
    const made = readFileSync(join(dataDir, '.infisical-encryption-key'), 'utf8');
    expect(made).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(join(dataDir, '.infisical-encryption-key')).mode & 0o777).toBe(0o600);
    const gitea = first.steps.access.apply.mock.calls.map(([, manifest]) => JSON.parse(manifest) as { metadata: { name: string }; stringData?: Record<string, string> }).find((m) => m.metadata.name === 'gitea-admin');
    expect(gitea?.stringData).toEqual({ username: 'provisioning-bot', password: 'kept-from-before' });
    const second = cluster();
    await provisionPlatformServices(second.steps, place(dataDir), () => undefined, now);
    expect(readFileSync(join(dataDir, '.infisical-encryption-key'), 'utf8')).toBe(made);
    const stamps = [first, second].map(({ steps }) => steps.infra.deploy.mock.calls.find(([stack]) => stack === 'platform-infisical')![1]!.env!.SECRET_STAMP);
    expect(stamps[0]).toBe(stamps[1]);
  });

  it('refuses a secret file that is there but empty, rather than making a new secret over data the old one sealed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'koala-platform-'));
    writeFileSync(join(dataDir, '.infisical-encryption-key'), '\n');
    const { steps } = cluster();
    await expect(provisionPlatformServices(steps, place(dataDir), () => undefined, now)).rejects.toThrow(`${join(dataDir, '.infisical-encryption-key')} is empty; Infisical's secret ENCRYPTION_KEY was kept there, and a new one would not open what the old one sealed`);
    expect(steps.infra.deploy.mock.calls.map(([stack]) => stack)).not.toContain('platform-infisical');
  });

  it('stops at the service that can never come up, saying which workload and why, and applies nothing after it', async () => {
    const { steps } = cluster({ hopeless: 'crawl4ai' });
    const failed = await provisionPlatformServices(steps, place(), () => undefined, now).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(CannotRollOut);
    expect((failed as CannotRollOut).message).toBe('Crawl4AI cannot finish: crawl4ai cannot make its pods: pods "x" is forbidden: exceeded quota: none');
    expect(steps.infra.deploy.mock.calls.map(([stack]) => stack)).toEqual(['platform-egress', 'platform-searxng', 'platform-crawl4ai']);
  });

  it('leaves Infisical uninstalled, saying what to do, while a webhook left by a failed install would refuse every Ingress', async () => {
    const { steps } = cluster({ webhook: { items: [{ metadata: { name: 'infisical-ingress-nginx-admission' }, webhooks: [{ clientConfig: {} }] }] } });
    await expect(provisionPlatformServices(steps, place(), () => undefined, now)).rejects.toThrow('Infisical cannot be applied: the webhook infisical-ingress-nginx-admission has no certificate authority');
    expect(steps.infra.deploy.mock.calls.map(([stack]) => stack)).not.toContain('platform-infisical');
  });
});
