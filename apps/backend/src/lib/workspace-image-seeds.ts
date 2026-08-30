export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base';

export type EgressRule =
  | { cidr: string; namespace?: undefined; ports?: number[] }
  | { namespace: string; cidr?: undefined; ports?: number[] };

export interface WorkspaceImageSpec {
  id: WorkspaceLanguage;
  ownerId?: string | undefined;
  image: string;
  summary: string;
  available: string[];
  absent: string[];
  /**
   * What a package manager in this image needs to reach its registry — the env that points it
   * somewhere reachable, and the egress that lets it get there. Without both, `npm install` and
   * `pip install` fail inside the sandbox, which is why it travels with the image rather than
   * being decided at the call site.
   */
  packageAccess: { env: { name: string; value: string }[]; egress: EgressRule[] };
}

export const WORKSPACE_MOUNT = '/work';
export const EGRESS_PROXY_HOST = 'egress-proxy.koala-egress.svc.cluster.local:8888';
export const EGRESS_PROXY_EGRESS: EgressRule = { namespace: 'koala-egress', ports: [8888] };

const PROXY_ENV = [
  { name: 'HTTPS_PROXY', value: `http://${EGRESS_PROXY_HOST}` },
  { name: 'https_proxy', value: `http://${EGRESS_PROXY_HOST}` },
];

export const WORKSPACE_IMAGE_SEEDS: WorkspaceImageSpec[] = [
  {
    id: 'node',
    image: 'registry.access.redhat.com/ubi9/nodejs-22',
    summary: 'Node.js 22 + npm. Also has Python 3.9, gcc and make.',
    available: ['bash', 'git 2.52', 'node 22', 'npm', 'npx', 'python3 3.9', 'gcc', 'make', 'curl', 'tar'],
    absent: ['go', 'pip', 'wget', 'jq'],
    packageAccess: {
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://verdaccio.koala-registry.svc.cluster.local:4873' }],
      egress: [{ namespace: 'koala-registry', ports: [4873] }],
    },
  },
  {
    id: 'python',
    image: 'registry.access.redhat.com/ubi9/python-312',
    summary: 'Python 3.12 + pip and venv. Also has Node 22, gcc and make.',
    available: ['bash', 'git 2.52', 'python3 3.12', 'pip', 'venv', 'node 22', 'npm', 'gcc', 'make', 'curl', 'wget', 'tar'],
    absent: ['go', 'jq'],
    packageAccess: {
      env: [
        { name: 'PIP_INDEX_URL', value: 'https://pypi.org/simple' },
        { name: 'PIP_TARGET', value: `${WORKSPACE_MOUNT}/.python-packages` },
        { name: 'PYTHONPATH', value: `${WORKSPACE_MOUNT}/.python-packages` },
        ...PROXY_ENV,
      ],
      egress: [EGRESS_PROXY_EGRESS],
    },
  },
  {
    id: 'go',
    image: 'registry.access.redhat.com/ubi9/go-toolset',
    summary: 'Go 1.26 toolchain. Also has Node 22, Python 3.9, gcc and make.',
    available: ['bash', 'git 2.52', 'go 1.26', 'node 22', 'npm', 'python3 3.9', 'gcc', 'make', 'curl', 'wget', 'tar'],
    absent: ['pip', 'jq'],
    packageAccess: {
      env: [
        { name: 'GOPROXY', value: 'https://proxy.golang.org,direct' },
        { name: 'GOSUMDB', value: 'sum.golang.org' },
        ...PROXY_ENV,
      ],
      egress: [EGRESS_PROXY_EGRESS],
    },
  },
  {
    id: 'base',
    image: 'registry.access.redhat.com/ubi9/ubi',
    summary: 'Minimal shell environment. No git, no compilers — shell and text editing only.',
    available: ['bash', 'python3 3.9', 'curl', 'tar'],
    absent: ['git', 'node', 'npm', 'go', 'pip', 'gcc', 'make', 'wget', 'jq'],
    packageAccess: { env: [], egress: [] },
  },
];

export const DEFAULT_WORKSPACE_LANGUAGE: WorkspaceLanguage = 'node';

export interface WorkspaceImageStore {
  getWorkspaceImages(ownerId?: string): Promise<WorkspaceImageSpec[]>;
  saveWorkspaceImage(image: WorkspaceImageSpec): Promise<void>;
}

export async function seedWorkspaceImages(store: WorkspaceImageStore): Promise<number> {
  const stored = await store.getWorkspaceImages().catch(() => [] as WorkspaceImageSpec[]);
  const have = new Set(stored.filter((i) => i.ownerId === undefined).map((i) => i.id));

  let seeded = 0;
  for (const seed of WORKSPACE_IMAGE_SEEDS) {
    if (have.has(seed.id)) continue;
    await store.saveWorkspaceImage({ ...seed });
    seeded++;
  }
  return seeded;
}

/**
 * The shipped rows keyed by language. For tests and for anything that legitimately wants the
 * catalogue as shipped rather than as a user sees it — a user's own row shadows a seed, so
 * anything serving a request must read the database instead.
 */
export const seedsByLanguage: Record<WorkspaceLanguage, WorkspaceImageSpec> =
  Object.fromEntries(WORKSPACE_IMAGE_SEEDS.map((s) => [s.id, s])) as Record<WorkspaceLanguage, WorkspaceImageSpec>;
