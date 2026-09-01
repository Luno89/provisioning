import { bindingProjection, bindingSecretName } from './service-binding.js';
import { detailsForImage, imageForLanguage } from './workspace-image-catalogue.js';
import {
  DEFAULT_WORKSPACE_LANGUAGE, EGRESS_PROXY_EGRESS, EGRESS_PROXY_HOST, WORKSPACE_MOUNT,
  type EgressRule, type WorkspaceImageSpec,
} from './workspace-image-seeds.js';

export type { WorkspaceLanguage, EgressRule } from './workspace-image-seeds.js';
export { DEFAULT_WORKSPACE_LANGUAGE, WORKSPACE_MOUNT, EGRESS_PROXY_HOST, EGRESS_PROXY_EGRESS };

export const MAX_WORKSPACE_SECONDS = 3600;

export const DEFAULT_WORKSPACE_CPU = '2';
export const DEFAULT_WORKSPACE_MEMORY = '2Gi';

export interface WorkspaceSpec {
  leafId: string;
  ownerId: string;
  image?: string;
  cpu?: string;
  memory?: string;
  egress?: EgressRule[];
  bindings?: WorkspaceBinding[];
  env?: { name: string; value: string }[];
}

export interface WorkspaceBinding {
  name: string;
  files: Record<string, string>;
}

export function egressForBindings(
  bindings: readonly { port: number; source: { namespace: string } }[],
): EgressRule[] {
  const byNamespace = new Map<string, Set<number>>();
  for (const b of bindings) {
    const ports = byNamespace.get(b.source.namespace) ?? new Set<number>();
    ports.add(b.port);
    byNamespace.set(b.source.namespace, ports);
  }
  return [...byNamespace.entries()].map(([namespace, ports]) => ({ namespace, ports: [...ports] }));
}

export function workspaceNamespace(leafId: string): string {
  const slug = leafId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Cannot derive a workspace namespace from leaf id ${JSON.stringify(leafId)}`);
  return `koala-ws-${slug}`.slice(0, 63).replace(/-+$/, '');
}

export const WORKSPACE_POD = 'workspace';

/**
 * Never an empty string: an unseeded catalogue used to surface as a pod whose image was '', which
 * Kubernetes rejects with a message about the manifest rather than about the seed that is missing.
 */
function podImage(rows: readonly WorkspaceImageSpec[], spec: WorkspaceSpec): string {
  const image = spec.image ?? imageForLanguage(rows);
  if (!image) {
    throw new Error('No workspace image: the catalogue is empty. Run the seeder (scripts/seed-all.ts).');
  }
  return image;
}

export function buildWorkspaceManifests(
  rows: readonly WorkspaceImageSpec[],
  spec: WorkspaceSpec,
): Record<string, unknown>[] {
  const namespace = workspaceNamespace(spec.leafId);
  const labels = { 'koala.dev/leaf': spec.leafId, 'koala.dev/owner': spec.ownerId, 'app': 'koala-workspace' };

  const bindings = spec.bindings ?? [];
  const projection = bindingProjection(
    bindings.map((b) => ({ name: b.name, secretName: bindingSecretName(b.name) })),
  );
  const bindingSecrets = bindings.map((b) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: bindingSecretName(b.name), namespace, labels },
    type: 'Opaque',
    stringData: b.files,
  }));

  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace, labels },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'default-deny', namespace, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [],
        egress: [
          {
            ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
          },
          ...(spec.egress ?? []).map((rule) => ({
            to: [
              rule.namespace
                ? { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': rule.namespace } } }
                : { ipBlock: { cidr: rule.cidr } },
            ],
            ...(rule.ports?.length
              ? { ports: rule.ports.map((port) => ({ protocol: 'TCP', port })) }
              : {}),
          })),
        ],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: WORKSPACE_POD, namespace, labels },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        activeDeadlineSeconds: MAX_WORKSPACE_SECONDS,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'workspace',
            image: podImage(rows, spec),
            command: ['sleep', String(MAX_WORKSPACE_SECONDS)],
            workingDir: WORKSPACE_MOUNT,
            env: [
              { name: 'HOME', value: WORKSPACE_MOUNT },
              { name: 'XDG_CACHE_HOME', value: `${WORKSPACE_MOUNT}/.cache` },
              { name: 'GOPATH', value: `${WORKSPACE_MOUNT}/.cache/go` },
              { name: 'GOCACHE', value: `${WORKSPACE_MOUNT}/.cache/go-build` },
              { name: 'GOMODCACHE', value: `${WORKSPACE_MOUNT}/.cache/go-mod` },
              { name: 'npm_config_cache', value: `${WORKSPACE_MOUNT}/.npm` },
              { name: 'PIP_CACHE_DIR', value: `${WORKSPACE_MOUNT}/.cache/pip` },
              ...projection.env,
              ...(spec.env ?? []),
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              readOnlyRootFilesystem: true,
            },
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: spec.cpu ?? DEFAULT_WORKSPACE_CPU, memory: spec.memory ?? DEFAULT_WORKSPACE_MEMORY },
            },
            volumeMounts: [
              { name: 'work', mountPath: WORKSPACE_MOUNT },
              { name: 'tmp', mountPath: '/tmp' },
              ...projection.volumeMounts,
            ],
          },
        ],
        volumes: [
          { name: 'work', emptyDir: {} },
          { name: 'tmp', emptyDir: {} },
          ...projection.volumes,
        ],
      },
    },
    ...bindingSecrets,
  ];
}

const PACKAGE_MANAGERS = [
  { tool: 'npm', env: 'NPM_CONFIG_REGISTRY', command: 'npm install' },
  { tool: 'pip', env: 'PIP_INDEX_URL', command: 'pip install' },
  { tool: 'go', env: 'GOPROXY', command: 'go mod download' },
] as const;

/**
 * The same environment, in the third person, for whoever is PLANNING work rather than doing it.
 *
 * `describeSandbox` is written to the agent that is inside the container ("you run shell commands",
 * "you have 2 CPUs"). Appending that to a planner's prompt told it that it had a shell, which is
 * how the planner ended up trying to build the product instead of decomposing it. The facts are
 * the same and still come from the seeded image rows; only the addressee changes.
 */
export function describeWorkerSandbox(rows: readonly WorkspaceImageSpec[]): string {
  const languages = [...new Set(rows.map((r) => r.id))];
  return [
    'THE ENVIRONMENT THE WORK RUNS IN',
    '',
    'You are not in this environment and cannot reach it. Each leaf you propose is carried out later',
    'by a different agent inside a Linux container. Do not propose work it cannot do:',
    '',
    `- The container has a shell and a writable ${WORKSPACE_MOUNT}. Its root filesystem is read-only`,
    '  and there is no sudo, so nothing can install system packages.',
    '- There is no general internet. A package registry is mirrored inside the cluster, so a package',
    '  install works; fetching an arbitrary URL does not.',
    `- It is destroyed after ${MAX_WORKSPACE_SECONDS / 60} minutes, taking anything uncommitted with it.`,
    ...(languages.length ? [`- Available images: ${languages.join(', ')}.`] : []),
  ].join('\n');
}

export function describeSandbox(
  rows: readonly WorkspaceImageSpec[],
  spec: Pick<WorkspaceSpec, 'image' | 'cpu' | 'memory' | 'egress' | 'env'> = {},
): string {
  const image = spec.image ?? imageForLanguage(rows);
  const tools = detailsForImage(rows, image);

  const reachable = (spec.egress ?? []).map((rule) => {
    const ports = rule.ports?.length ? ` on port ${rule.ports.join(', ')}` : '';
    return rule.namespace ? `the ${rule.namespace} service${ports}` : `${rule.cidr}${ports}`;
  });

  const managers = PACKAGE_MANAGERS
    .filter((m) => tools?.available.some((t) => t === m.tool || t.startsWith(`${m.tool} `)))
    .map((m) => ({ ...m, served: (spec.env ?? []).find((e) => e.name === m.env)?.value }));

  const served = managers.filter((m) => m.served);
  const unserved = managers.filter((m) => !m.served);
  const packages = [
    ...served.map((m) => `\`${m.command}\` works — it is pointed at ${m.served}.`),
    ...(unserved.length
      ? [`\`${unserved.map((m) => m.command).join('` and `')}\` WILL fail: nothing serves `
        + `${unserved.map((m) => m.tool).join(' or ')} here, so build with what the image provides.`]
      : []),
  ].join(' ');

  const network = reachable.length
    ? `Outbound network is blocked except DNS and ${reachable.join(', ')}. `
      + (packages || 'Nothing else on the public internet is reachable.')
    : 'There is NO outbound network beyond DNS. `git clone` and any download WILL fail. ' + packages;

  return [
    'YOUR EXECUTION ENVIRONMENT',
    '',
    `You run shell commands in a Linux container (${image}). Facts that will cost you an attempt if ignored:`,
    '',
    `- Each command runs in a FRESH shell. \`cd\` and environment variables do NOT carry over to your`,
    `  next command. Chain steps in one command (\`cd x && npm test\`) or use absolute paths.`,
    `- ${WORKSPACE_MOUNT} is your working directory and the only writable place apart from /tmp.`,
    '  The root filesystem is read-only, so you cannot install system packages.',
    `- You are a non-root user. There is no sudo.`,
    `- ${network}`,
    `- You have ${spec.cpu ?? DEFAULT_WORKSPACE_CPU} CPUs and ${spec.memory ?? DEFAULT_WORKSPACE_MEMORY} of memory. IGNORE \`nproc\` and \`free\` —`,
    '  they report the host machine, not your limits, and building as if they were true gets you killed.',
    `- The sandbox is destroyed after ${MAX_WORKSPACE_SECONDS / 60} minutes, and everything in it goes with it.`,
    ...(tools
      ? [
          `- Available: ${tools.available.join(', ')}.`,
          `- NOT installed: ${tools.absent.join(', ')}. Do not plan around them.`,
        ]
      : ['- The tools in this image are not catalogued; check with `command -v <tool>` before relying on one.']),
  ].join('\n');
}
