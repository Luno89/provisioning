import { imageReference, needsBuilding, renderDockerfile, type ImagePlan } from '../image.js';
import type { KubeRunner } from './kube.js';

export const BUILD_NAMESPACE = 'koala-builds';

export const BUILD_SERVICE_ACCOUNT = 'pipeline-build-sa';

export const BUILD_TIMEOUT_MS = 20 * 60_000;

export class ImageBuildError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ImageBuildError';
  }
}

export const REGISTRY_SERVICE = { namespace: 'gitea', service: 'gitea-http' };

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

  if (address.exitCode !== 0 || !address.stdout.trim()) {
    throw new ImageBuildError('Could not find the node address the registry is reachable at.');
  }

  return `${address.stdout.trim()}:${port.stdout.trim()}`;
}

export interface ImageBuilderOptions {
  run: KubeRunner;
  registry?: string | undefined;
  namespace?: string | undefined;
  timeoutMs?: number | undefined;
  published?: ((reference: string) => Promise<boolean>) | undefined;
}

export interface ImageBuilder {
  ensure(plan: ImagePlan): Promise<string>;
  exists(plan: ImagePlan): Promise<boolean>;
}

const jobName = (plan: ImagePlan): string => `ws-build-${plan.fingerprint.slice(0, 16)}`;

function buildManifests(input: {
  plan: ImagePlan;
  namespace: string;
  reference: string;
  timeoutMs: number;
}): Record<string, unknown>[] {
  const name = jobName(input.plan);
  const dockerfile = renderDockerfile(input.plan);

  return [
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
                volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
                resources: {
                  requests: { cpu: '250m', memory: '512Mi' },
                  limits: { cpu: '2', memory: '2Gi' },
                },
              },
            ],
            volumes: [{ name: 'workspace', configMap: { name } }],
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

  const published = options.published ?? (async (reference: string) => {
    const tag = reference.slice(reference.lastIndexOf(':') + 1);
    const response = await fetch(
      `http://${await registry()}/v2/koala/workspace/manifests/${tag}`,
      { method: 'HEAD', headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' } },
    );
    return response.ok;
  });

  const exists = async (plan: ImagePlan): Promise<boolean> =>
    published(imageReference(await registry(), plan));

  return {
    exists,

    async ensure(plan: ImagePlan): Promise<string> {
      if (!needsBuilding(plan)) return plan.base;

      const reference = imageReference(await registry(), plan);
      if (await exists(plan).catch(() => false)) return reference;

      const manifests = buildManifests({ plan, namespace, reference, timeoutMs });
      const doc = manifests.map((manifest) => JSON.stringify(manifest)).join('\n---\n');

      const applied = await run(['apply', '-f', '-'], doc);
      if (applied.exitCode !== 0) {
        throw new ImageBuildError(`Could not start the image build: ${applied.stderr || applied.stdout}`);
      }

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
