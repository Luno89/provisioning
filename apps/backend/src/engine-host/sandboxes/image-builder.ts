import { ignore } from '@koala/engine-core/failures';
import { imageReference, needsBuilding, renderDockerfile, type ImagePlan } from '@koala/agent-engine';
import type { KubeRunner } from './kube.js';
import { assessWorkload } from '@koala/provision';
import { forPushing, kanikoRegistryArgs, type RegistryHosts } from '../../instances/lib/registry-hosts.js';
import { dockerConfigJson } from '../../instances/lib/registry-pull.js';
import { failureOf, reportingFetch, type DependencyReporter } from '../../platform/lib/dependencies.js';
import { reopening, type Reopening } from '@koala/engine-core/reopening';
import { elapsedSeconds, koalaMetrics, withSpan } from '@koala/engine-core/telemetry';

export const BUILD_NAMESPACE = 'pipeline-builds';

export const BUILD_SERVICE_ACCOUNT = 'pipeline-build-sa';

/** How often a run waiting for its image asks the cluster what the build is doing. */
export const BUILD_POLL_MS = 5_000;

/** How many times a build job that vanished is started again before that is taken as an answer. */
export const BUILD_RESTARTS = 2;

/**
 * Pinned. `latest` would tie every workspace image to whatever gcr.io serves that day — the one
 * part of an otherwise fingerprinted build that could change underneath a fingerprint that had not.
 */
export const KANIKO_IMAGE = 'gcr.io/kaniko-project/executor:v1.24.0';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export class ImageBuildError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ImageBuildError';
  }
}

export interface RegistryAccount {
  owner: string;
  username: string;
  password: string;
}

export interface ImageBuilderOptions {
  run: KubeRunner;
  registry: RegistryHosts | { none: string };
  namespace?: string | undefined;
  pollMs?: number | undefined;
  published?: ((reference: string) => Promise<boolean>) | undefined;
  askAgain?: (() => Reopening) | undefined;
  account?: (() => Promise<RegistryAccount>) | undefined;
  pushToken?: (() => Promise<PushToken>) | undefined;
  revokePushToken: (name: string) => Promise<void>;
  reportsTo?: DependencyReporter | undefined;
}

export interface PushToken {
  username: string;
  password: string;
  name?: string | undefined;
}

export const PUSH_TOKEN_ANNOTATION = 'koala.dev/push-token';
const REGISTRY_SECRET_SUFFIX = '-registry';

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
const PROOF_FAILED = /^the dependency \S+ said it puts .+ in the workspace, and once it was installed .+ is not there$/;

export function lastComplaint(logs: string): string | undefined {
  const lines = logs
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => line && !NOISE.test(line));

  const unproved = lines.filter((line) => PROOF_FAILED.test(line));
  if (unproved.length) return unproved.join('; ');
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
  hosts: RegistryHosts;
  dockerConfigJson?: string | undefined;
  pushToken?: string | undefined;
}): Record<string, unknown>[] {
  const name = jobName(input.plan);
  const dockerfile = renderDockerfile(input.plan);
  const login = input.dockerConfigJson !== undefined;

  return [
    ...(login ? [{
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: `${name}${REGISTRY_SECRET_SUFFIX}`,
        namespace: input.namespace,
        labels: { 'koala.dev/image': input.plan.fingerprint },
        ...(input.pushToken ? { annotations: { [PUSH_TOKEN_ANNOTATION]: input.pushToken } } : {}),
      },
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
        ttlSecondsAfterFinished: 600,
        template: {
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: BUILD_SERVICE_ACCOUNT,
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'kaniko',
                image: KANIKO_IMAGE,
                args: [
                  '--context=dir:///workspace',
                  '--dockerfile=/workspace/Dockerfile',
                  `--destination=${forPushing(input.reference, input.hosts)}`,
                  '--compressed-caching=false',
                  '--snapshot-mode=redo',
                  ...kanikoRegistryArgs(input.hosts),
                ],
                volumeMounts: [
                  { name: 'workspace', mountPath: '/workspace' },
                  ...(login ? [{ name: 'registry', mountPath: '/kaniko/.docker' }] : []),
                ],
                resources: {
                  requests: { cpu: '250m', memory: '1Gi' },
                  limits: { cpu: '2', memory: '10Gi' },
                },
              },
            ],
            volumes: [
              { name: 'workspace', configMap: { name } },
              ...(login ? [{
                name: 'registry',
                secret: {
                  secretName: `${name}${REGISTRY_SECRET_SUFFIX}`,
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
  const pollMs = options.pollMs ?? BUILD_POLL_MS;
  const { run } = options;

  const hosts = async (): Promise<RegistryHosts> => {
    if ('none' in options.registry) throw new ImageBuildError(options.registry.none);
    return options.registry;
  };

  const registry = async (): Promise<string> => (await hosts()).pull;

  const account = async (): Promise<RegistryAccount | undefined> => options.account?.();

  const target = async (plan: ImagePlan): Promise<string> =>
    imageReference(await registry(), plan, (await account())?.owner);

  const asked: typeof fetch = (input, init) => fetch(input, init);
  const registryFetch = options.reportsTo ? reportingFetch(options.reportsTo, 'registry', asked) : asked;
  const published = options.published ?? (async (reference: string) => {
    const tag = reference.slice(reference.lastIndexOf(':') + 1);
    const login = await account();
    const path = reference.slice(reference.indexOf('/') + 1, reference.lastIndexOf(':'));
    const response = await registryFetch(
      `http://${(await hosts()).push}/v2/${path}/manifests/${tag}`,
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
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw Object.assign(new Error(`the image registry answered ${response.status} when asked whether ${reference} is published`), { status: response.status });
  });

  const exists = async (plan: ImagePlan): Promise<boolean> => published(await target(plan));

  const releaseFinishedTokens = async (): Promise<void> => {
    const secrets = await run(['get', 'secrets', '-n', namespace, '-l', 'koala.dev/image', '-o', 'json'], undefined, undefined);
    if (secrets.exitCode !== 0) throw new Error(`the builds' secrets could not be listed: ${(secrets.stderr || secrets.stdout).trim()}`);
    const items = (JSON.parse(secrets.stdout || '{}') as { items?: { metadata: { name: string; annotations?: Record<string, string> } }[] }).items ?? [];
    for (const secret of items) {
      const token = secret.metadata.annotations?.[PUSH_TOKEN_ANNOTATION];
      if (!token || !secret.metadata.name.endsWith(REGISTRY_SECRET_SUFFIX)) continue;
      const job = secret.metadata.name.slice(0, -REGISTRY_SECRET_SUFFIX.length);
      const read = await run(['get', 'job', job, '-n', namespace, '-o', 'jsonpath={.status.active}|{.status.succeeded}|{.status.failed}'], undefined, undefined)
        .catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
      const gone = read.exitCode !== 0 && /not ?found/i.test(`${read.stderr}${read.stdout}`);
      const counts = read.exitCode === 0 ? countsIn(read.stdout) : undefined;
      if (!gone && !(counts && !counts.active && (counts.succeeded || counts.failed))) continue;
      await options.revokePushToken(token);
      await run(['delete', 'secret', secret.metadata.name, '-n', namespace, '--ignore-not-found'], undefined, undefined).catch(ignore('the token it held is revoked already, and the next pass finds the secret again and deletes it'));
    }
  };

  const releaseTokensNow = (): Promise<void> => releaseFinishedTokens().catch((err: unknown) => {
    console.warn(`[images] the push tokens of finished builds stay valid until the next try, at the next build or check: ${(err as Error).message}`);
  });

  const inRegistry = async (plan: ImagePlan): Promise<boolean> => {
    const again = (options.askAgain ?? reopening)();
    let told: string | undefined;
    for (;;) {
      try {
        return await exists(plan);
      } catch (err) {
        const failure = failureOf(err);
        if (failure.kind === 'final') throw new ImageBuildError(`The image registry could not be asked whether ${plan.fingerprint} is built: ${(err as Error).message}`);
        if (failure.reason !== told) console.warn(`[images] the image registry could not say whether ${plan.fingerprint} is built (${failure.reason}); asking again`);
        told = failure.reason;
        await again.after();
      }
    }
  };

  const apply = async (plan: ImagePlan, reference: string): Promise<void> => {
    await releaseTokensNow();
    const push = options.pushToken ? await options.pushToken() : await options.account?.();
    const registryHosts = await hosts();
    const config = push ? dockerConfigJson(registryHosts, push) : undefined;
    const pushToken = push && 'name' in push ? push.name : undefined;
    const manifests = buildManifests({
      plan, namespace, reference, hosts: registryHosts, ...(config ? { dockerConfigJson: config } : {}), ...(pushToken ? { pushToken } : {}),
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
      undefined,
    ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));

    return lastComplaint(logs.stdout) ?? 'the build job failed';
  };

  const stuckBecause = async (plan: ImagePlan): Promise<string | undefined> => {
    const read = await run(
      ['get', 'pods', '-l', `job-name=${jobName(plan)}`, '-n', namespace, '-o', 'json'],
      undefined,
      undefined,
    ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    if (read.exitCode !== 0) return undefined;
    try {
      const health = assessWorkload(JSON.parse(read.stdout));
      return health.health === 'unhealthy' ? health.reason : undefined;
    } catch {
      return undefined;
    }
  };

  const jobStanding = async (plan: ImagePlan, reference: string): Promise<ImageStanding> => {
    const read = await run(
      ['get', 'job', jobName(plan), '-n', namespace, '-o', 'jsonpath={.status.active}|{.status.succeeded}|{.status.failed}'],
      undefined,
      undefined,
    ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));

    if (read.exitCode !== 0) return { state: 'unbuilt', reference };

    const { active, succeeded, failed } = countsIn(read.stdout);
    if (!active && (succeeded || failed)) await releaseTokensNow();
    if (failed) return { state: 'failed', reference, detail: await whyItFailed(plan) };
    if (active) {
      const stuck = await stuckBecause(plan);
      return stuck ? { state: 'failed', reference, detail: stuck } : { state: 'building', reference };
    }
    if (succeeded) return { state: 'building', reference, detail: 'built, waiting for the registry to serve it' };

    return { state: 'unbuilt', reference };
  };

  const standing = async (plan: ImagePlan): Promise<ImageStanding> => {
    if (!needsBuilding(plan)) return { state: 'ready', reference: plan.base };

    const reference = await target(plan);
    if (await inRegistry(plan)) {
      await releaseTokensNow();
      return { state: 'ready', reference };
    }

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
      if (await inRegistry(plan)) return reference;

      const startedAt = Date.now();
      const measure = (outcome: string) => koalaMetrics().imageBuildSeconds.record(elapsedSeconds(startedAt), { kind: 'workspace', outcome });
      return withSpan('image.build', { 'koala.image.kind': 'workspace', 'koala.image.fingerprint': plan.fingerprint }, async () => {
        await apply(plan, reference);

        let restarted = 0;

        for (;;) {
          const state = await standing(plan);

          if (state.state === 'ready') {
            measure('ok');
            await releaseTokensNow();
            return reference;
          }
          if (state.state === 'failed') {
            measure('failed');
            throw new ImageBuildError(`The workspace image did not build: ${state.detail ?? 'no reason given'}`);
          }
          if (state.state === 'unbuilt') {
            if (restarted >= BUILD_RESTARTS) {
              measure('failed');
              throw new ImageBuildError('The workspace image build job disappeared, and starting it again did not stick');
            }
            restarted += 1;
            await apply(plan, reference);
          }
          await sleep(pollMs);
        }
      });
    },
  };
}
