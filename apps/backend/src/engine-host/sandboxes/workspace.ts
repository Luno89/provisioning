import type { EgressMode } from '@koala/agent-engine';

export type EgressRule =
  | { cidr: string; namespace?: undefined; ports?: number[] }
  | { namespace: string; cidr?: undefined; ports?: number[] };

export const WORK_DIR = '/work';

export const POD = 'workspace';

export const DEFAULT_CPU = '2';
export const DEFAULT_MEMORY = '2Gi';


export const MAX_LIFETIME_MS = 12 * 60 * 60_000;

export const EGRESS_PROXY: EgressRule = { namespace: 'koala-egress', ports: [8888] };

export interface RunWorkspace {
  runId: string;
  ownerId: string;
  agent: string;
  image: string;
  provides: string[];
  lifetimeMs: number;
  cpu: string;
  memory: string;
  egress: EgressRule[];
  env: { name: string; value: string }[];
  egressMode: EgressMode;
}

export const REGISTRY_MIRROR = 'http://verdaccio.koala-registry.svc.cluster.local:4873';

export const PROXY_HOST = 'egress-proxy.koala-egress.svc.cluster.local:8888';

export const COMMON_BINARIES = [
  'git', 'node', 'npm', 'python3', 'pip', 'go', 'gcc', 'make', 'curl', 'wget', 'tar', 'jq',
  'diff', 'cmp',
];

export interface PackageAccess {
  env: { name: string; value: string }[];
  egress: EgressRule[];
}

const PROXY_ENV = [
  { name: 'HTTPS_PROXY', value: `http://${PROXY_HOST}` },
  { name: 'https_proxy', value: `http://${PROXY_HOST}` },
];

export function packageAccessFor(provides: readonly string[]): PackageAccess {
  const has = (binary: string) => provides.includes(binary);
  const env: { name: string; value: string }[] = [];
  const egress: EgressRule[] = [];

  if (has('npm')) {
    env.push({ name: 'NPM_CONFIG_REGISTRY', value: REGISTRY_MIRROR });
    egress.push({ namespace: 'koala-registry', ports: [4873] });
  }

  if (has('pip') || has('go')) {
    if (has('pip')) {
      env.push(
        { name: 'PIP_INDEX_URL', value: 'https://pypi.org/simple' },
        { name: 'PIP_TARGET', value: `${WORK_DIR}/.python-packages` },
        { name: 'PYTHONPATH', value: `${WORK_DIR}/.python-packages` },
      );
    }
    if (has('go')) {
      env.push(
        { name: 'GOPROXY', value: 'https://proxy.golang.org,direct' },
        { name: 'GOSUMDB', value: 'sum.golang.org' },
      );
    }
    env.push(...PROXY_ENV);
    egress.push(EGRESS_PROXY);
  }

  return { env, egress };
}

export function absentFrom(provides: readonly string[]): string[] {
  return COMMON_BINARIES.filter((binary) => !provides.includes(binary));
}

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

export function lifetimeFor(wallClockLimitMs: number | undefined): number {
  const wanted = wallClockLimitMs && wallClockLimitMs > 0 ? wallClockLimitMs * 1.25 : MAX_LIFETIME_MS;
  return Math.min(Math.ceil(wanted), MAX_LIFETIME_MS);
}

export function egressFor(
  mode: EgressMode,
  access: PackageAccess,
  granted: readonly EgressRule[] = [],
): EgressRule[] {
  if (mode === 'none') return [];

  const viaProxy = mode === 'auto' || granted.length > 0 ? [EGRESS_PROXY] : [];
  const all = [...access.egress, ...granted, ...viaProxy];

  return all.filter((rule, index) => all.findIndex((other) =>
    other.namespace === rule.namespace && other.cidr === rule.cidr) === index);
}

export function buildManifests(workspace: RunWorkspace): Record<string, unknown>[] {
  const namespace = workspaceName(workspace.runId);
  const seconds = Math.ceil(workspace.lifetimeMs / 1000);

  const labels = {
    'koala.dev/run': labelValue(workspace.runId),
    'koala.dev/agent': labelValue(workspace.agent),
    'koala.dev/owner': labelValue(workspace.ownerId),
    app: 'koala-workspace',
  };

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
          { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
          ...workspace.egress.map((rule) => ({
            to: [
              rule.namespace
                ? { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': rule.namespace } } }
                : { ipBlock: { cidr: rule.cidr } },
            ],
            ...(rule.ports?.length ? { ports: rule.ports.map((port) => ({ protocol: 'TCP', port })) } : {}),
          })),
        ],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: POD, namespace, labels },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        activeDeadlineSeconds: seconds,
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
            command: ['sleep', String(seconds)],
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
          { name: 'work', emptyDir: {} },
          { name: 'tmp', emptyDir: {} },
        ],
      },
    },
  ];
}

const PACKAGE_MANAGERS = [
  { binary: 'npm', env: 'NPM_CONFIG_REGISTRY', command: 'npm install' },
  { binary: 'pip', env: 'PIP_INDEX_URL', command: 'pip install' },
  { binary: 'go', env: 'GOPROXY', command: 'go mod download' },
] as const;

function reachable(workspace: RunWorkspace): string[] {
  return workspace.egress.map((rule) => {
    const ports = rule.ports?.length ? ` on port ${rule.ports.join(', ')}` : '';
    return rule.namespace ? `the ${rule.namespace} service${ports}` : `${rule.cidr}${ports}`;
  });
}

function packageNote(workspace: RunWorkspace): string {
  const present = PACKAGE_MANAGERS.filter((manager) =>
    workspace.provides.includes(manager.binary));

  const served = present.filter((manager) => workspace.env.some((entry) => entry.name === manager.env));
  const unserved = present.filter((manager) => !served.includes(manager));

  return [
    ...served.map((manager) => `\`${manager.command}\` works.`),
    ...(unserved.length
      ? [`\`${unserved.map((m) => m.command).join('` and `')}\` WILL fail — nothing serves ${unserved.map((m) => m.binary).join(' or ')} here.`]
      : []),
  ].join(' ');
}

export function describeWorkspace(workspace: RunWorkspace): string {
  const minutes = Math.round(workspace.lifetimeMs / 60_000);
  const open = workspace.egressMode === 'auto';
  const hosts = reachable(workspace);

  const network = open
    ? 'Outbound network is open.'
    : hosts.length > 0
      ? `Outbound network is blocked except DNS and ${hosts.join(', ')}. ${packageNote(workspace)}`
      : `There is NO outbound network beyond DNS. \`git clone\` and any download WILL fail. ${packageNote(workspace)}`;

  return [
    'YOUR EXECUTION ENVIRONMENT',
    '',
    `You run shell commands in a Linux container (${workspace.image}). Facts that will cost`,
    'you an attempt if you ignore them:',
    '',
    '- Each command runs in a FRESH shell. `cd` and environment variables do NOT carry over to your',
    '  next command. Chain steps in one command (`cd x && npm test`) or use absolute paths.',
    `- ${WORK_DIR} is your working directory and the only writable place apart from /tmp.`,
    '  The root filesystem is read-only, so you cannot install system packages.',
    '- You are a non-root user. There is no sudo.',
    `- ${network}`,
    `- You have ${workspace.cpu} CPUs and ${workspace.memory} of memory. IGNORE \`nproc\` and \`free\` —`,
    '  they report the host machine, not your limits, and building as if they were true gets you killed.',
    `- This container belongs to this run alone and is destroyed when the run ends, or after`,
    `  ${minutes} minutes, whichever comes first. Anything not committed or returned as an output is lost.`,
    `- Available: ${workspace.provides.join(', ')}.`,
    `- NOT installed: ${absentFrom(workspace.provides).join(', ')}. Do not plan around them.`,
  ].join('\n');
}

export function describeForDelegation(bases: readonly string[] = []): string {
  const available = [...new Set(bases)];

  return [
    'WHERE THE WORK YOU PROPOSE WILL RUN',
    '',
    'You are not in that environment and cannot reach it. Each task you propose is carried out later',
    'by a different agent, in its own Linux container. Do not propose work it cannot do:',
    '',
    `- The container has a shell and a writable ${WORK_DIR}. Its root filesystem is read-only and`,
    '  there is no sudo, so nothing can install system packages.',
    '- There is no general internet. A package registry is mirrored inside the cluster, so installing',
    '  a dependency works; fetching an arbitrary URL does not.',
    '- It belongs to that one task and is destroyed when the task ends, taking anything uncommitted.',
    ...(available.length > 0 ? [`- Images it can be given: ${available.join(', ')}.`] : []),
  ].join('\n');
}

export function describeMachine(deviceName: string, root: string): string {
  return [
    'YOUR EXECUTION ENVIRONMENT',
    '',
    `You are working directly on ${deviceName}, a real machine belonging to the person you are`,
    'helping. This is not a sandbox: what you change persists, and a mistake costs them real work.',
    '',
    `- You are confined to ${root}. Paths outside it are refused.`,
    '- Every command is shown to them for approval before it runs. Expect to wait, and make each',
    '  command worth approving: say plainly what it does if that is not obvious.',
    '- Nothing here constrains the network. Treat anything you fetch or send as really happening.',
    '- Nothing here is thrown away afterwards. Clean up what you create.',
  ].join('\n');
}

export function describeNoEnvironment(): string {
  return [
    'YOUR EXECUTION ENVIRONMENT',
    '',
    'You have no machine this turn. You cannot run commands, and you cannot read or write files.',
    'Everything you do has to come from this conversation or from the tools listed below.',
  ].join('\n');
}
