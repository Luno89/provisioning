import type { EgressMode } from '../agent/agent.js';

export type EgressRule =
  | { cidr: string; namespace?: undefined; ports?: number[] }
  | { namespace: string; cidr?: undefined; ports?: number[] };

export const WORK_DIR = '/work';

export const POD = 'workspace';

export const DEFAULT_CPU = '2';
export const DEFAULT_MEMORY = '2Gi';

export const DEFAULT_LIFETIME_MS = 30 * 60_000;

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
  persistent?: boolean | undefined;
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

export function workspaceName(runId: string): string {
  const slug = runId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Cannot name a workspace from run id ${JSON.stringify(runId)}`);
  return `koala-run-${slug}`.slice(0, 63).replace(/-+$/, '');
}

export function lifetimeFor(budgetMs: number | undefined): number {
  const wanted = budgetMs && budgetMs > 0 ? budgetMs * 1.25 : DEFAULT_LIFETIME_MS;
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

export function describeWorkspace(workspace: RunWorkspace, worktree?: string): string {
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
    ...(worktree
      ? [
        `- ${WORK_DIR}/${worktree} is your working directory: a git worktree of the tree's repo, on its own branch.`,
        '  Commands start there and file tools resolve every path from there, so use paths relative to it',
        `  (PLAN.md, not ${WORK_DIR}/${worktree}/PLAN.md). The rest of ${WORK_DIR} belongs to other leaves of the tree —`,
        '  do not cd out of your worktree. The root filesystem is read-only, so you cannot install system packages.',
      ]
      : [
        `- ${WORK_DIR} is your working directory and the only writable place apart from /tmp.`,
        '  The root filesystem is read-only, so you cannot install system packages.',
      ]),
    '- You are a non-root user. There is no sudo.',
    `- ${network}`,
    `- You have ${workspace.cpu} CPUs and ${workspace.memory} of memory. IGNORE \`nproc\` and \`free\` —`,
    '  they report the host machine, not your limits, and building as if they were true gets you killed.',
    ...(workspace.persistent
      ? [
        `- This container belongs to the tree, not to this run: ${WORK_DIR} is kept between runs and other runs of the tree`,
        '  work in it too, each in its own worktree. Commit your work on your branch — that is what is judged.',
      ]
      : [
        `- This container belongs to this run alone and is destroyed when the run ends, or after`,
        `  ${minutes} minutes, whichever comes first. Anything not committed or returned as an output is lost.`,
      ]),
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
