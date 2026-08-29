import { bindingProjection, bindingSecretName } from './service-binding.js';

export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base';

export interface WorkspaceImage {
  image: string;
  summary: string;
  available: string[];
  absent: string[];
}

export const WORKSPACE_IMAGES: Record<WorkspaceLanguage, WorkspaceImage> = {
  node: {
    image: 'registry.access.redhat.com/ubi9/nodejs-22',
    summary: 'Node.js 22 + npm. Also has Python 3.9, gcc and make.',
    available: ['bash', 'git 2.52', 'node 22', 'npm', 'npx', 'python3 3.9', 'gcc', 'make', 'curl', 'tar'],
    absent: ['go', 'pip', 'wget', 'jq'],
  },
  python: {
    image: 'registry.access.redhat.com/ubi9/python-312',
    summary: 'Python 3.12 + pip and venv. Also has Node 22, gcc and make.',
    available: ['bash', 'git 2.52', 'python3 3.12', 'pip', 'venv', 'node 22', 'npm', 'gcc', 'make', 'curl', 'wget', 'tar'],
    absent: ['go', 'jq'],
  },
  go: {
    image: 'registry.access.redhat.com/ubi9/go-toolset',
    summary: 'Go 1.26 toolchain. Also has Node 22, Python 3.9, gcc and make.',
    available: ['bash', 'git 2.52', 'go 1.26', 'node 22', 'npm', 'python3 3.9', 'gcc', 'make', 'curl', 'wget', 'tar'],
    absent: ['pip', 'jq'],
  },
  base: {
    image: 'registry.access.redhat.com/ubi9/ubi',
    summary: 'Minimal shell environment. No git, no compilers — shell and text editing only.',
    available: ['bash', 'python3 3.9', 'curl', 'tar'],
    absent: ['git', 'node', 'npm', 'go', 'pip', 'gcc', 'make', 'wget', 'jq'],
  },
};

export const DEFAULT_WORKSPACE_LANGUAGE: WorkspaceLanguage = 'node';
export const DEFAULT_WORKSPACE_IMAGE = WORKSPACE_IMAGES[DEFAULT_WORKSPACE_LANGUAGE].image;

export function isWorkspaceLanguage(value: unknown): value is WorkspaceLanguage {
  return typeof value === 'string' && value in WORKSPACE_IMAGES;
}

export function imageForLanguage(language?: string): string {
  return isWorkspaceLanguage(language) ? WORKSPACE_IMAGES[language].image : DEFAULT_WORKSPACE_IMAGE;
}

export function capableImage(language: string | undefined, requires: readonly string[] = []): string {
  const asked = imageForLanguage(language);
  if (!requires.length) return asked;

  const entry = Object.values(WORKSPACE_IMAGES).find((i) => i.image === asked);
  const missing = requires.filter((tool) => entry?.absent.includes(tool));
  if (!missing.length) return asked;

  const capable = Object.values(WORKSPACE_IMAGES)
    .find((i) => requires.every((tool) => !i.absent.includes(tool)));
  return capable?.image ?? asked;
}

export const WORKSPACE_MOUNT = '/work';

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

export type EgressRule =
  | { cidr: string; namespace?: undefined; ports?: number[] }
  | { namespace: string; cidr?: undefined; ports?: number[] };

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

export function buildWorkspaceManifests(spec: WorkspaceSpec): Record<string, unknown>[] {
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
            image: spec.image ?? DEFAULT_WORKSPACE_IMAGE,
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

const IMAGE_DETAILS: Record<string, WorkspaceImage> = Object.fromEntries(
  Object.values(WORKSPACE_IMAGES).map((entry) => [entry.image, entry]),
);

export const EGRESS_PROXY_HOST = 'egress-proxy.koala-egress.svc.cluster.local:8888';
export const EGRESS_PROXY_EGRESS: EgressRule = { namespace: 'koala-egress', ports: [8888] };

const PROXY_ENV = [
  { name: 'HTTPS_PROXY', value: `http://${EGRESS_PROXY_HOST}` },
  { name: 'https_proxy', value: `http://${EGRESS_PROXY_HOST}` },
];

const PACKAGE_ACCESS: Record<WorkspaceLanguage, { env: { name: string; value: string }[]; egress: EgressRule[] }> = {
  node: {
    env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://verdaccio.koala-registry.svc.cluster.local:4873' }],
    egress: [{ namespace: 'koala-registry', ports: [4873] }],
  },
  python: {
    env: [
      { name: 'PIP_INDEX_URL', value: 'https://pypi.org/simple' },
      { name: 'PIP_TARGET', value: `${WORKSPACE_MOUNT}/.python-packages` },
      { name: 'PYTHONPATH', value: `${WORKSPACE_MOUNT}/.python-packages` },
      ...PROXY_ENV,
    ],
    egress: [EGRESS_PROXY_EGRESS],
  },
  go: {
    env: [
      { name: 'GOPROXY', value: 'https://proxy.golang.org,direct' },
      { name: 'GOSUMDB', value: 'sum.golang.org' },
      ...PROXY_ENV,
    ],
    egress: [EGRESS_PROXY_EGRESS],
  },
  base: { env: [], egress: [] },
};

export function packageAccess(
  language: string | undefined,
): { env: { name: string; value: string }[]; egress: EgressRule[] } {
  const key = isWorkspaceLanguage(language) ? language : DEFAULT_WORKSPACE_LANGUAGE;
  const entry = PACKAGE_ACCESS[key];
  return { env: entry.env.map((e) => ({ ...e })), egress: entry.egress.map((r) => ({ ...r, ...(r.ports ? { ports: [...r.ports] } : {}) })) };
}

const PACKAGE_MANAGERS = [
  { tool: 'npm', env: 'NPM_CONFIG_REGISTRY', command: 'npm install' },
  { tool: 'pip', env: 'PIP_INDEX_URL', command: 'pip install' },
  { tool: 'go', env: 'GOPROXY', command: 'go mod download' },
] as const;

export function describeSandbox(spec: Pick<WorkspaceSpec, 'image' | 'cpu' | 'memory' | 'egress' | 'env'> = {}): string {
  const image = spec.image ?? DEFAULT_WORKSPACE_IMAGE;
  const tools = IMAGE_DETAILS[image];

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
