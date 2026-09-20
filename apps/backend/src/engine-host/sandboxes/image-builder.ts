import { imageReference, needsBuilding, renderDockerfile, type ImagePlan } from '@koala/agent-engine';
import type { KubeRunner } from './kube.js';

export const BUILD_NAMESPACE = 'pipeline-builds';

export const BUILD_SERVICE_ACCOUNT = 'pipeline-build-sa';

export const BUILD_TIMEOUT_MS = 20 * 60_000;

export class ImageBuildError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ImageBuildError';
  }
}

export const REGISTRY_SERVICE = { namespace: 'gitea', service: 'gitea-http' };

export function pickAddress(addresses: string): string | undefined {
  const all = addresses.trim().split(/\s+/).filter(Boolean);
  return all.find((address) => !address.includes(':')) ?? all[0];
}

export async function discoverRegistry(run: KubeRunner): Promise<string> {
  const port = await run([
    'get', 'svc', REGISTRY_SERVICE.service, '-n', REGISTRY_SERVICE.namespace,
    '-o', 'jsonpath={.spec.ports[0].nodePort}',
  ], undefined, 15_000);

  if (port.exitCode !== 0 || !port.stdout.trim()) {
    throw new ImageBuildError(
      `Could not find the image registry (${REGISTRY_SERVICE.service} in ${REGISTRY_SERVICE.namespace}). `
      + 'Workspace images cannot be built until it is running.',
    );
  }

  const address = await run([
    'get', 'nodes', '-o',
    'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}',
  ], undefined, 15_000);

  const reachable = pickAddress(address.stdout);
  if (address.exitCode !== 0 || !reachable) {
    throw new ImageBuildError('Could not find the node address the registry is reachable at.');
  }

  return `${reachable}:${port.stdout.trim()}`;
}

export interface RegistryAccount {
  owner: string;
  username: string;
  password: string;
}

export interface ImageBuilderOptions {
  run: KubeRunner;
  registry?: string | undefined;
  namespace?: string | undefined;
  timeoutMs?: number | undefined;
  published?: ((reference: string) => Promise<boolean>) | undefined;
  account?: (() => Promise<RegistryAccount>) | undefined;
  pushToken?: (() => Promise<{ username: string; password: string }>) | undefined;
}

export function dockerConfigFor(host: string, login: { username: string; password: string }): string {
  return JSON.stringify({
    auths: { [host]: { auth: Buffer.from(`${login.username}:${login.password}`).toString('base64') } },
  });
}

export type ImageState = 'ready' | 'building' | 'failed' | 'unbuilt';

export interface ImageStanding {
  state: ImageState;
  reference: string;
  detail?: string | undefined;
}

export interface ImageBuilder {
  ensure(plan: ImagePlan): Promise<string>;
  exists(plan: ImagePlan): Promise<boolean>;
  start(plan: ImagePlan): Promise<ImageStanding>;
  standing(plan: ImagePlan): Promise<ImageStanding>;
}

const jobName = (plan: ImagePlan): string => `ws-build-${plan.fingerprint.slice(0, 16)}`;

const NOISE = /^(INFO|DEBUG|WARN)\b/;

export function lastComplaint(logs: string): string | undefined {
  const lines = logs
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => line && !NOISE.test(line));

  return lines.find((line) => /error|failed|no match|not found|cannot/i.test(line)) ?? lines.at(-1);
}

export function countsIn(status: string): { active: number; succeeded: number; failed: number } {
  const [active, succeeded, failed] = status.split('|').map((value) => Number(value.trim()) || 0);
  return { active: active ?? 0, succeeded: succeeded ?? 0, failed: failed ?? 0 };
}

function buildManifests(input: {
  plan: ImagePlan;
  namespace: string;
  reference: string;
  timeoutMs: number;
  dockerConfigJson?: string | undefined;
}): Record<string, unknown>[] {
  const name = jobName(input.plan);
  const dockerfile = renderDockerfile(input.plan);
  const login = input.dockerConfigJson !== undefined;

  return [
    ...(login ? [{
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: `${name}-registry`, namespace: input.namespace },
      type: 'kubernetes.io/dockerconfigjson',
      stringData: { '.dockerconfigjson': input.dockerConfigJson },
    }] : []),
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace: input.namespace },
      data: { Dockerfile: dockerfile },
    },
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, namespace: input.namespace, labels: { 'koala.dev/image': input.plan.fingerprint } },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: Math.ceil(input.timeoutMs / 1000),
        ttlSecondsAfterFinished: 600,
        template: {
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: BUILD_SERVICE_ACCOUNT,
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'kaniko',
                image: 'gcr.io/kaniko-project/executor:latest',
                args: [
                  '--context=dir:///workspace',
                  '--dockerfile=/workspace/Dockerfile',
                  `--destination=${input.reference}`,
                  '--insecure',
                  '--insecure-pull',
                  '--skip-tls-verify',
                ],
                volumeMounts: [
                  { name: 'workspace', mountPath: '/workspace' },
                  ...(login ? [{ name: 'registry', mountPath: '/kaniko/.docker' }] : []),
                ],
                resources: {
                  requests: { cpu: '250m', memory: '512Mi' },
                  limits: { cpu: '2', memory: '2Gi' },
                },
              },
            ],
            volumes: [
              { name: 'workspace', configMap: { name } },
              ...(login ? [{
                name: 'registry',
                secret: {
                  secretName: `${name}-registry`,
                  items: [{ key: '.dockerconfigjson', path: 'config.json' }],
                },
              }] : []),
            ],
          },
        },
      },
    },
  ];
}

export function createImageBuilder(options: ImageBuilderOptions): ImageBuilder {
  const namespace = options.namespace ?? BUILD_NAMESPACE;
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
  const { run } = options;

  let found: string | undefined = options.registry;
  const registry = async (): Promise<string> => {
    found ??= await discoverRegistry(run);
    return found;
  };

  const account = async (): Promise<RegistryAccount | undefined> => options.account?.();

  const target = async (plan: ImagePlan): Promise<string> =>
    imageReference(await registry(), plan, (await account())?.owner);

  const published = options.published ?? (async (reference: string) => {
    const tag = reference.slice(reference.lastIndexOf(':') + 1);
    const login = await account();
    const path = reference.slice(reference.indexOf('/') + 1, reference.lastIndexOf(':'));
    const response = await fetch(
      `http://${await registry()}/v2/${path}/manifests/${tag}`,
      {
        method: 'HEAD',
        headers: {
          Accept: 'application/vnd.oci.image.manifest.v1+json',
          ...(login
            ? { Authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}` }
            : {}),
        },
      },
    );
    return response.ok;
  });

  const exists = async (plan: ImagePlan): Promise<boolean> => published(await target(plan));

  const apply = async (plan: ImagePlan, reference: string): Promise<void> => {
    const push = await (options.pushToken ?? options.account)?.();
    const dockerConfigJson = push ? dockerConfigFor(await registry(), push) : undefined;
    const manifests = buildManifests({
      plan, namespace, reference, timeoutMs, ...(dockerConfigJson ? { dockerConfigJson } : {}),
    });
    const doc = manifests.map((manifest) => JSON.stringify(manifest)).join('\n---\n');
    const applied = await run(['apply', '-f', '-'], doc);

    if (applied.exitCode !== 0) {
      throw new ImageBuildError(`Could not start the image build: ${applied.stderr || applied.stdout}`);
    }
  };

  const whyItFailed = async (plan: ImagePlan): Promise<string> => {
    const logs = await run(
      ['logs', `job/${jobName(plan)}`, '-n', namespace, '--tail=40'],
      undefined,
      20_000,
    ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));

    return lastComplaint(logs.stdout) ?? 'the build job failed';
  };

  const jobStanding = async (plan: ImagePlan, reference: string): Promise<ImageStanding> => {
    const read = await run(
      ['get', 'job', jobName(plan), '-n', namespace, '-o', 'jsonpath={.status.active}|{.status.succeeded}|{.status.failed}'],
      undefined,
      15_000,
    ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));

    if (read.exitCode !== 0) return { state: 'unbuilt', reference };

    const { active, succeeded, failed } = countsIn(read.stdout);
    if (failed) return { state: 'failed', reference, detail: await whyItFailed(plan) };
    if (active) return { state: 'building', reference };
    if (succeeded) return { state: 'building', reference, detail: 'built, waiting for the registry to serve it' };

    return { state: 'unbuilt', reference };
  };

  const standing = async (plan: ImagePlan): Promise<ImageStanding> => {
    if (!needsBuilding(plan)) return { state: 'ready', reference: plan.base };

    const reference = await target(plan);
    if (await exists(plan).catch(() => false)) return { state: 'ready', reference };

    return jobStanding(plan, reference);
  };

  return {
    exists,
    standing,

    async start(plan: ImagePlan): Promise<ImageStanding> {
      const now = await standing(plan);
      if (now.state !== 'unbuilt') return now;

      await apply(plan, now.reference);
      return { state: 'building', reference: now.reference };
    },

    async ensure(plan: ImagePlan): Promise<string> {
      if (!needsBuilding(plan)) return plan.base;

      const reference = await target(plan);
      if (await exists(plan).catch(() => false)) return reference;

      await apply(plan, reference);

      const waited = await run(
        ['wait', '--for=condition=complete', `job/${jobName(plan)}`, '-n', namespace,
          `--timeout=${Math.ceil(timeoutMs / 1000)}s`],
        undefined,
        timeoutMs + 10_000,
      );

      if (waited.exitCode !== 0) {
        const logs = await run(
          ['logs', `job/${jobName(plan)}`, '-n', namespace, '--tail=40'],
          undefined,
          30_000,
        ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));

        throw new ImageBuildError(
          `The workspace image did not build: ${logs.stdout.trim() || waited.stderr || 'no output'}`,
        );
      }

      return reference;
    },
  };
}
