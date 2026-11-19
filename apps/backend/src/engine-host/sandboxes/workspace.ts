import { POD, WORK_DIR, type RunWorkspace } from '@koala/agent-engine';
import { WORKSPACE_STAMP, workspaceStamp } from '../../engine/lib/published-workspace.js';
import { CLUSTER_DNS_EGRESS } from '../../engine/lib/workspace-spec.js';
import { POD_PULL_SECRETS, REGISTRY_PULL_SECRET, registryPullSecret, type RegistryLogin } from '../../instances/lib/registry-pull.js';
import { publicIpBlock } from '../../infrastructure/lib/egress-rules.js';

export const WORK_VOLUME = 'work';
export const WORK_VOLUME_SIZE = '10Gi';

const NAME_LIMIT = 63;

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function shorten(slug: string, from: string, limit: number): string {
  if (slug.length <= limit) return slug;
  const tail = fingerprint(from);
  return `${slug.slice(0, limit - tail.length - 1).replace(/-+$/, '')}-${tail}`;
}

export function workspaceName(runId: string): string {
  const slug = runId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Cannot name a workspace from run id ${JSON.stringify(runId)}`);
  return shorten(`koala-run-${slug}`, runId, NAME_LIMIT);
}

export function labelValue(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return shorten(slug, text, NAME_LIMIT);
}

export function lifetimeFor(wallClockLimitMs: number | undefined): number | undefined {
  return wallClockLimitMs && wallClockLimitMs > 0 ? Math.ceil(wallClockLimitMs * 1.25) : undefined;
}

export function buildManifests(workspace: RunWorkspace, pull?: RegistryLogin | undefined): Record<string, unknown>[] {
  const namespace = workspaceName(workspace.runId);
  const seconds = workspace.lifetimeMs ? Math.ceil(workspace.lifetimeMs / 1000) : undefined;

  const labels = {
    'koala.dev/run': labelValue(workspace.runId),
    'koala.dev/agent': labelValue(workspace.agent),
    'koala.dev/owner': labelValue(workspace.ownerId),
    app: 'koala-workspace',
  };

  const volume = workspace.persistent
    ? [{
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: WORK_VOLUME, namespace, labels },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: WORK_VOLUME_SIZE } } },
    }]
    : [];

  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace, labels },
    },
    ...volume,
    ...(pull ? [{ ...registryPullSecret(namespace, pull), metadata: { name: REGISTRY_PULL_SECRET, namespace, labels } }] : []),
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'default-deny', namespace, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [],
        egress: [
          CLUSTER_DNS_EGRESS,
          ...workspace.egress.map((rule) => ({
            to: [
              rule.cidr === undefined
                ? { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': rule.namespace } } }
                : publicIpBlock(rule.cidr),
            ],
            ...(rule.ports?.length ? { ports: rule.ports.map((port) => ({ protocol: 'TCP', port })) } : {}),
          })),
        ],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: POD, namespace, labels, annotations: { [WORKSPACE_STAMP]: workspaceStamp(workspace) } },
      spec: {
        automountServiceAccountToken: false,
        ...(pull ? { imagePullSecrets: [...POD_PULL_SECRETS] } : {}),
        restartPolicy: 'Never',
        terminationGracePeriodSeconds: 1,
        ...(seconds ? { activeDeadlineSeconds: seconds } : {}),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: POD,
            image: workspace.image,
            command: ['sleep', seconds ? String(seconds) : 'infinity'],
            workingDir: WORK_DIR,
            env: [
              { name: 'HOME', value: WORK_DIR },
              { name: 'XDG_CACHE_HOME', value: `${WORK_DIR}/.cache` },
              { name: 'GOPATH', value: `${WORK_DIR}/.cache/go` },
              { name: 'GOCACHE', value: `${WORK_DIR}/.cache/go-build` },
              { name: 'GOMODCACHE', value: `${WORK_DIR}/.cache/go-mod` },
              { name: 'npm_config_cache', value: `${WORK_DIR}/.npm` },
              { name: 'PIP_CACHE_DIR', value: `${WORK_DIR}/.cache/pip` },
              ...workspace.env,
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              readOnlyRootFilesystem: true,
            },
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: workspace.cpu, memory: workspace.memory },
            },
            volumeMounts: [
              { name: 'work', mountPath: WORK_DIR },
              { name: 'tmp', mountPath: '/tmp' },
            ],
          },
        ],
        volumes: [
          workspace.persistent
            ? { name: 'work', persistentVolumeClaim: { claimName: WORK_VOLUME } }
            : { name: 'work', emptyDir: {} },
          { name: 'tmp', emptyDir: {} },
        ],
      },
    },
  ];
}
