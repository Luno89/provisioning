import { bindingProjection, bindingSecretName } from './service-binding.js';
/**
 * Manifests for a leaf's sandbox.
 *
 * ── WHY THIS IS A SEPARATE, PURE FILE ──
 * The sandbox runs code written by a model, in response to text a model read. It is remote code
 * execution by design, so the isolation boundary is the deliverable — not a detail of whichever
 * service happens to create the pod. Kept pure so every property below can be asserted in a unit
 * test instead of being eyeballed in a YAML blob.
 *
 * ── WHAT THE BOUNDARY IS ──
 * - No service-account token. Without this the pod can call the Kubernetes API as whatever
 *   identity it inherited, which on a management cluster is the one that provisions clusters.
 * - Default-deny egress, DNS excepted. The agent loop runs OUTSIDE the pod, so the sandbox has no
 *   reason to reach the model endpoint, the backend, Mongo, or another tenant's namespace. What it
 *   legitimately needs (a package registry, a git remote) is an explicit allowlist, so adding a
 *   hole is a visible edit rather than an accident.
 * - Non-root, no privilege escalation, all capabilities dropped.
 * - CPU/memory limits and a hard deadline, so a runaway loop cannot exhaust the node or outlive
 *   the leaf that created it.
 *
 * None of this contains prompt injection — a model that reads a poisoned repo still acts on it.
 * It contains the blast radius: what an injected instruction can reach is what the tool set and
 * this policy permit, and there is no credential in here to steal.
 */

/**
 * The languages a workspace can be created for.
 *
 * A closed set, not a free-text image field. The model picks one of these by name, so it can never
 * name an image that was never vetted — and every entry has been probed rather than assumed, since
 * the tool list below is what the model plans against.
 *
 * Red Hat UBI throughout. The s2i language images each carry git plus a full compiler toolchain,
 * which is what makes the commit → push loop possible without building an image of our own.
 */
export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base';

export interface WorkspaceImage {
  image: string;
  /** One line, shown to the model in the tool schema so it can choose without a round trip. */
  summary: string;
  available: string[];
  absent: string[];
}

/**
 * Probed live on 2026-08-03, not copied from documentation.
 *
 * The overlaps are real and worth keeping: the Node image also has Python 3.9, and the Go and
 * Python images both carry Node 22 — so a task that needs a second language usually does not need
 * a second workspace.
 */
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
    // Kept for tasks that are only shell and text. Deliberately last: it has NO git, so anything
    // that ends in a commit must not choose it.
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

/** Resolves a language to its image, falling back rather than failing — an unknown language from a
 *  model should produce a working default, not a dead leaf. */
export function imageForLanguage(language?: string): string {
  return isWorkspaceLanguage(language) ? WORKSPACE_IMAGES[language].image : DEFAULT_WORKSPACE_IMAGE;
}

/**
 * The image for a language, upgraded if it cannot do what the workspace needs.
 *
 * ── WHY THIS EXISTS RATHER THAN A LANGUAGE THAT LIES ──
 * A research paper is prose; its honest language is `base` — "shell and text editing only". But
 * every tree takes a checkout now, and `base` has no git, so the tree-type seeds were quietly
 * changed to `node`: encoding "must be able to clone" as "is a Node project". Wrong field. The
 * requirement belongs to the checkout, and the catalogue already declares what each image lacks.
 *
 * So this reads the data rather than naming a case: start from what the work asked for, and if that
 * image is `absent` something the workspace requires, take the first that is not. Add git to `base`
 * tomorrow and this stops upgrading, with nothing to remember.
 *
 * Falls back to the declared language when NOTHING satisfies the requirement — building what was
 * asked for and failing at the command beats substituting an unrelated toolchain over a requirement
 * no image lists.
 */
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

/** Where the leaf's files live. An emptyDir, so teardown takes the contents with it. */
export const WORKSPACE_MOUNT = '/work';

/** Hard ceiling on a sandbox's life, whatever the agent does. Idle teardown is separate and
 *  shorter; this is the backstop for a pod nothing is watching any more. */
export const MAX_WORKSPACE_SECONDS = 3600;

/**
 * Sandbox size when a persona does not name one.
 *
 * Named because they were inline literals in two places — the pod spec and the prompt that TELLS
 * the agent its limits — and those two disagreeing is the sort of thing that has an agent building
 * as if it had the host's cores.
 */
export const DEFAULT_WORKSPACE_CPU = '2';
export const DEFAULT_WORKSPACE_MEMORY = '2Gi';

export interface WorkspaceSpec {
  /** The leaf this sandbox belongs to. One sandbox per leaf. */
  leafId: string;
  ownerId: string;
  image?: string;
  cpu?: string;
  memory?: string;
  /** Hosts the sandbox may reach, as CIDRs and ports. Empty means DNS only. */
  egress?: EgressRule[];
  /**
   * Services bound into the sandbox, projected at `$SERVICE_BINDING_ROOT`.
   *
   * ── WHY A SANDBOX GETS THESE AT ALL ──
   * A leaf is told to read its connection details from `$SERVICE_BINDING_ROOT` at runtime, and until
   * now the projection happened only at DEPLOY time — so a leaf could write integration code and
   * never execute a line of it. Measured across two projects: an agent looked for
   * `$SERVICE_BINDING_ROOT` at step 2, found nothing, searched the whole filesystem for it, then
   * spent five steps guessing DNS names; when it finally guessed right the NetworkPolicy refused
   * the connection and it spent fourteen more steps debugging its own client.
   *
   * Files are passed in rather than read here so this module stays pure. `WorkspaceService` reads
   * the source Secrets, because it is the thing that holds a kubectl.
   */
  bindings?: WorkspaceBinding[];
  /**
   * Variables to inject, on top of the fixed toolchain ones.
   *
   * Last, so a caller that deliberately overrides HOME or a cache path wins. Those defaults exist
   * because a read-only root filesystem breaks any toolchain that wants somewhere to write, so
   * replacing one is a decision rather than an oversight.
   */
  env?: { name: string; value: string }[];
}

/**
 * One hole in the default-deny egress policy.
 *
 * Two forms, and the namespace form is the one to reach for. A NodePort address does NOT work as a
 * `cidr` rule: kube-proxy DNATs the packet before the policy is evaluated, so by the time it is
 * checked the destination is the backing pod's IP and the rule naming the node silently fails
 * closed. Measured — a git clone through an allowlisted NodePort was refused until this became a
 * namespace selector. For the same reason the port here is the POD's port, not the NodePort.
 */
export type EgressRule =
  | { cidr: string; namespace?: undefined; ports?: number[] }
  | { namespace: string; cidr?: undefined; ports?: number[] };

/** One binding, with its files already read. Each file becomes a key of a Secret, and so a filename. */
export interface WorkspaceBinding {
  name: string;
  files: Record<string, string>;
}

/**
 * The egress a set of bindings needs, and nothing more.
 *
 * ── DERIVED, NOT DECLARED ──
 * Hand-writing egress alongside a dependency means two lists that must agree, and the one that
 * silently wins is the network policy. Taking it from the resolved binding means a leaf reaches
 * exactly what its project declared a need for, and opening a hole without a dependency that
 * survived the ownership check in `binding-resolve.ts` is not possible.
 *
 * The `namespace` form is mandatory here rather than preferred — see the note on `EgressRule`:
 * kube-proxy DNATs a NodePort before the policy is evaluated, so a rule naming the node fails
 * closed. The port is the service's pod port, which is what `resolveBindings` returns.
 */
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

/**
 * Kubernetes names: lowercase alphanumerics and dashes, 63 characters, must start and end
 * alphanumeric. A leaf id is a UUID so it already complies, but this is what stands between a
 * hand-made id and a manifest that either fails to apply or applies somewhere unintended.
 */
export function workspaceNamespace(leafId: string): string {
  const slug = leafId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Cannot derive a workspace namespace from leaf id ${JSON.stringify(leafId)}`);
  return `koala-ws-${slug}`.slice(0, 63).replace(/-+$/, '');
}

/** Pod name inside that namespace. Fixed, so exec never has to look one up. */
export const WORKSPACE_POD = 'workspace';

export function buildWorkspaceManifests(spec: WorkspaceSpec): Record<string, unknown>[] {
  const namespace = workspaceNamespace(spec.leafId);
  const labels = { 'koala.dev/leaf': spec.leafId, 'koala.dev/owner': spec.ownerId, 'app': 'koala-workspace' };

  /**
   * Bindings, as Secrets in THIS namespace and as mounts on the pod.
   *
   * In the same document rather than applied separately, which is the invariant
   * `WorkspaceService.create` rests on: a Pod without its NetworkPolicy is a sandbox with
   * unrestricted egress that still looks like a sandbox, and a Pod whose binding Secret is missing
   * never starts at all. One document makes both impossible.
   */
  const bindings = spec.bindings ?? [];
  const projection = bindingProjection(
    bindings.map((b) => ({ name: b.name, secretName: bindingSecretName(b.name) })),
  );
  const bindingSecrets = bindings.map((b) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: bindingSecretName(b.name), namespace, labels },
    type: 'Opaque',
    // `stringData`, so Kubernetes does the base64 and a value is never encoded twice.
    stringData: b.files,
  }));

  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      // Labelled with the owner so a NetworkPolicy elsewhere can select tenants, and so an orphan
      // sweep can find every sandbox belonging to a deleted user.
      metadata: { name: namespace, labels },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'default-deny', namespace, labels },
      spec: {
        // Empty selector = every pod in the namespace, including any the agent somehow creates.
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        // No ingress rules at all: nothing should ever dial INTO a sandbox. Commands arrive over
        // the API server's exec channel, which is not pod networking and so is unaffected.
        ingress: [],
        egress: [
          // DNS only. Without it even an allowlisted host is unreachable by name, and the failure
          // looks like a hang rather than a policy decision.
          {
            ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
          },
          ...(spec.egress ?? []).map((rule) => ({
            to: [
              rule.namespace
                // The label is applied automatically by Kubernetes, so this needs no cooperation
                // from whoever owns the target namespace.
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
        // THE line that keeps a sandbox off the Kubernetes API.
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
            // Idles. Work arrives as exec calls, so the container must stay up without running
            // anything of its own — a sandbox that executes something on start is a sandbox whose
            // first action nobody chose.
            command: ['sleep', String(MAX_WORKSPACE_SECONDS)],
            workingDir: WORKSPACE_MOUNT,
            /**
             * Every toolchain cache pointed at the one writable place.
             *
             * Stock images set HOME to `/` or `/home/<user>`, neither of which is writable under a
             * read-only root — so `go build` fails at "mkdir /.cache: read-only file system" before
             * compiling a line, and npm/pip fail the moment they want to cache anything. Verified
             * live: without this, Go cannot build hello-world.
             */
            env: [
              { name: 'HOME', value: WORKSPACE_MOUNT },
              { name: 'XDG_CACHE_HOME', value: `${WORKSPACE_MOUNT}/.cache` },
              // Go ignores HOME for GOPATH in enough configurations to be worth pinning outright.
              { name: 'GOPATH', value: `${WORKSPACE_MOUNT}/.cache/go` },
              { name: 'GOCACHE', value: `${WORKSPACE_MOUNT}/.cache/go-build` },
              { name: 'GOMODCACHE', value: `${WORKSPACE_MOUNT}/.cache/go-mod` },
              { name: 'npm_config_cache', value: `${WORKSPACE_MOUNT}/.npm` },
              { name: 'PIP_CACHE_DIR', value: `${WORKSPACE_MOUNT}/.cache/pip` },
              // SERVICE_BINDING_ROOT, when anything is bound. Before the caller's own entries so an
              // explicit override still wins.
              ...projection.env,
              // A later entry with the same name wins in Kubernetes, so a caller's own value
              // overrides the default above rather than being silently ignored.
              ...(spec.env ?? []),
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              // The mount is writable; the image is not. Anything that needs to write elsewhere is
              // asking to modify its own tooling, which is not a thing a task should need.
              readOnlyRootFilesystem: true,
            },
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: spec.cpu ?? DEFAULT_WORKSPACE_CPU, memory: spec.memory ?? DEFAULT_WORKSPACE_MEMORY },
            },
            volumeMounts: [
              { name: 'work', mountPath: WORKSPACE_MOUNT },
              // A read-only root still needs somewhere for temp files, or half of every toolchain
              // fails in ways that read as bugs in the task.
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

/** Lookup from image back to its catalogue entry, for describing a workspace after the fact. */
const IMAGE_DETAILS: Record<string, WorkspaceImage> = Object.fromEntries(
  Object.values(WORKSPACE_IMAGES).map((entry) => [entry.image, entry]),
);



/**
 * The one way out of a sandbox, for the tools that need one.
 *
 * A CONNECT proxy with `FilterDefaultDeny Yes` and a committed allowlist — see
 * `k8s/koala-egress/egress-proxy.yaml`. Named here so the NetworkPolicy rule and the proxy variables
 * come from the same constant: pointing a tool at a proxy the policy does not permit fails as a
 * connection timeout, which reads like the package index being down.
 */
export const EGRESS_PROXY_HOST = 'egress-proxy.koala-egress.svc.cluster.local:8888';
export const EGRESS_PROXY_EGRESS: EgressRule = { namespace: 'koala-egress', ports: [8888] };

/**
 * ── WHAT A LANGUAGE NEEDS IN ORDER TO INSTALL ANYTHING ──
 *
 * Derived from the language, because that is what decides it. This lived on persona records and
 * exactly one of eleven carried it: a Builder could `npm install` and a Merger standing in the same
 * repository could not, with nothing in the brief explaining the difference. Then tree types made a
 * Python workspace possible and the one persona that had a registry had the wrong one — it spent
 * every turn it had resolving `pypi-mirror` and `pypi-proxy` before the circling veto stopped it.
 *
 * Same argument as `GITEA_EGRESS`: a hand-written list beside a derivable fact is two lists that
 * must agree, and the one that silently wins is the NetworkPolicy.
 *
 * npm is served in-cluster by Verdaccio, which is a pull-through cache and therefore the tightest
 * option available. pip and go have no local mirror, so they go to the real index through the proxy.
 * Adding a mirror later means changing the value here and nothing else.
 *
 * Both spellings of the proxy variable are set on purpose: pip and curl read `https_proxy`, most Go
 * and Node tooling reads `HTTPS_PROXY`, and setting one alone fails in a way that looks like the
 * allowlist refusing the host.
 */
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
    // Explicit rather than left to pip's default, so `describeSandbox` can tell an agent that pip
    // has somewhere to go — the check is "is the index variable set", for every manager alike.
    env: [
      { name: 'PIP_INDEX_URL', value: 'https://pypi.org/simple' },
      /**
       * Somewhere writable to install INTO — the other half of making pip work.
       *
       * Layer 3 mounts the root filesystem read-only, and Python is the only one of the three
       * toolchains that installs outside the project directory: npm writes `./node_modules` and Go
       * writes `GOMODCACHE`, both already under `/work`. Measured in a live sandbox once egress was
       * open: every wheel downloaded through the proxy and the install then died with
       * `[Errno 30] Read-only file system: '/opt/app-root/lib/python3.12/site-packages/urllib3'`.
       *
       * `PIP_TARGET` rather than `--user`, because the image is a virtualenv and pip refuses
       * `--user` inside one ("User site-packages are not visible in this virtualenv"). `PYTHONPATH`
       * has to name the same directory or the install succeeds and the import still fails.
       */
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
  // No package manager, so nothing to point anywhere. Opening egress here would be a hole with no
  // tool that could use it.
  base: { env: [], egress: [] },
};

export function packageAccess(
  language: string | undefined,
): { env: { name: string; value: string }[]; egress: EgressRule[] } {
  // Falls back the same way `imageForLanguage` does — an unknown language gets the Node image, so it
  // must get the Node registry too, or it lands in a toolchain with nowhere to install from.
  const key = isWorkspaceLanguage(language) ? language : DEFAULT_WORKSPACE_LANGUAGE;
  const entry = PACKAGE_ACCESS[key];
  return { env: entry.env.map((e) => ({ ...e })), egress: entry.egress.map((r) => ({ ...r, ...(r.ports ? { ports: [...r.ports] } : {}) })) };
}

/**
 * Package managers, their index variable, and the command an agent would type.
 *
 * A table because the question "can I install things" has one answer per manager and the brief has
 * to give each of them — see the note in `describeSandbox`. `tool` matches the catalogue's
 * `available` entries, which carry versions (`node 22`), hence the prefix match at the call site.
 */
const PACKAGE_MANAGERS = [
  { tool: 'npm', env: 'NPM_CONFIG_REGISTRY', command: 'npm install' },
  { tool: 'pip', env: 'PIP_INDEX_URL', command: 'pip install' },
  { tool: 'go', env: 'GOPROXY', command: 'go mod download' },
] as const;

export function describeSandbox(spec: Pick<WorkspaceSpec, 'image' | 'cpu' | 'memory' | 'egress' | 'env'> = {}): string {
  const image = spec.image ?? DEFAULT_WORKSPACE_IMAGE;
  const tools = IMAGE_DETAILS[image];

  /**
   * What the sandbox can actually reach, said accurately.
   *
   * This mapped every rule to `e.cidr`, and the rule this codebase actually uses is the NAMESPACE
   * form — whose `cidr` is undefined. So a Builder with access to Gitea was told "blocked except
   * DNS and these hosts: ." and, because the list was non-empty, LOST the sentence saying package
   * installs fail.
   *
   * Measured consequence: the agent confidently ran `npm install --save-dev jest` against a
   * registry it cannot reach, got nothing back, spent two more steps checking whether node existed,
   * then stopped calling tools altogether and the leaf failed. It had never been told.
   */
  const reachable = (spec.egress ?? []).map((rule) => {
    const ports = rule.ports?.length ? ` on port ${rule.ports.join(', ')}` : '';
    return rule.namespace ? `the ${rule.namespace} service${ports}` : `${rule.cidr}${ports}`;
  });

  /**
   * Which package managers have somewhere to go — one answer PER MANAGER, not one for all of them.
   *
   * Read off the injected environment rather than guessed from the egress rules: a mirror is just
   * another namespace, and there is no way to tell one from a database by its name. If the variable
   * is set, something deliberately pointed that tool at an index.
   *
   * ── WHY PER MANAGER ──
   * This was one boolean — `NPM_CONFIG_REGISTRY || PIP_INDEX_URL` — and it said "a package registry
   * IS reachable … `npm install` works" whenever either was set. Correct while every workspace was
   * the Node image. The first leaf to run on a Python tree type got the Python image, the npm mirror
   * (which is always reachable), and that sentence: it concluded pip had an index, and spent every
   * turn it had resolving `pypi-mirror`, `pypi-proxy` and nine `.svc.cluster.local` variants before
   * the circling veto stopped it.
   *
   * Both directions of the mistake are expensive — an agent wrongly told installs fail hand-rolls a
   * library it could have installed — so each manager gets its own sentence, and only the ones the
   * image actually has are mentioned at all. `available` already records that per image, so adding a
   * pip mirror tomorrow is one entry here and nothing else.
   */
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
