/**
 * Reading why a deployment is not working.
 *
 * ── THE GUESS THIS REPLACES ──
 * Asked what was broken, Koala found a crash-looping MongoDB and said the cause was "insufficient
 * memory or a missing persistent volume". Plausible, and wrong. The actual reason was in the pod's
 * first ten lines:
 *
 *     "errmsg": "auth is not allowed when noauth is specified"
 *
 * It never saw that. `healthReason` is written by an HTTP probe that only runs for MCP servers, so
 * a crash-looping mongo reported "status is unhealthy" and the model reasoned from the app's name.
 * A feedback loop that reports a symptom sends the fix in the wrong direction; this reports the
 * cause.
 *
 * ── READ ONLY, AND THAT IS THE DESIGN ──
 * Everything needed to answer "why did my spec fail" is readable. A tool that could patch or delete
 * would be a cluster-admin credential handed to a language model, and the fix belongs in a corrected
 * spec that a person accepts — not in a live object mutated until it works.
 *
 * ── SCOPING IS THE SECURITY, AND IT IS NOT IN KUBERNETES ──
 * Pod logs contain whatever an app printed at startup, which is routinely a connection string or a
 * token. So a caller may only read namespaces belonging to their own deployments, and that fact
 * lives in this platform's database rather than in the cluster — which is exactly why this starts
 * in-process rather than as an MCP server. A server would have to be told who is asking, and
 * getting that wrong reads one tenant's secrets to another.
 */

export interface OwnedNamespace {
  name: string;
  namespace: string;
  ownerId?: string | undefined;
}

/** How many log lines are worth having. The cause is almost always near the end. */
export const LOG_TAIL = 60;
/** Longest output kept, so one screaming container cannot fill a turn's whole context. */
const MAX_OUTPUT = 6000;

/**
 * The namespace a caller may read for this deployment name, or undefined.
 *
 * Resolved from THEIR deployments rather than from the argument: a namespace taken straight from a
 * tool call would let any string be read, which is every other namespace on the cluster.
 */
export function namespaceFor(
  wanted: string,
  deployments: readonly OwnedNamespace[],
  ownerId: string,
): string | undefined {
  const needle = wanted.trim().toLowerCase();
  const mine = deployments.filter((d) => d.ownerId === ownerId);
  const found = mine.find(
    (d) => d.name.toLowerCase() === needle || d.namespace.toLowerCase() === needle,
  );
  return found?.namespace;
}

/** kubectl arguments for a deployment's logs. Built here so the shape is testable without a cluster. */
export function logsCommand(namespace: string): string[] {
  return [
    'logs', '-n', namespace,
    // Every pod of the deployment, and the PREVIOUS container when one has restarted — a
    // crash-looping pod's current container is usually still starting and says nothing useful.
    '--all-containers', '--prefix', '--tail', String(LOG_TAIL), '--previous=false',
    '-l', 'app',
  ];
}

/** kubectl arguments for a namespace's recent events, newest last. */
export function eventsCommand(namespace: string): string[] {
  // Events answer the failures logs cannot: an image that will not pull, a volume that never bound,
  // a pod that was never scheduled. Those produce no container output at all.
  return ['get', 'events', '-n', namespace, '--sort-by=.lastTimestamp'];
}

/** Trimmed to something a turn can hold, keeping the END, where the error is. */
export function trimOutput(raw: string): string {
  const text = String(raw ?? '').trim();
  if (text.length <= MAX_OUTPUT) return text;
  return `…[earlier output trimmed]\n${text.slice(-MAX_OUTPUT)}`;
}

/**
 * ── WIDENING THE READ SURFACE WITHOUT WIDENING THE RISK ──
 *
 * `get_logs` and `get_events` answer one question each, on one namespace. Everything else a person
 * would ask — why is this pod pending, what did the PVC bind to, is the node out of memory — was
 * unanswerable, so the model went back to reasoning from an app's name, which is the exact failure
 * the header of this file exists to record.
 *
 * The widening is bounded by three allowlists rather than by instructions. A refusal an agent can
 * argue with is a refusal that will eventually be argued with; these are conditions on an argv
 * array, so a mutating verb or a Secret is not a thing the tool can be persuaded to do.
 */

/**
 * Verbs that only read.
 *
 * Checked on argv[0], so this is the complete set of things the tool can do. `patch`, `delete`,
 * `apply`, `scale`, `exec`, `cp`, `port-forward` and `edit` are absent — a chat turn must not become
 * a cluster mutation with no verification layer and no Temporal record behind it. Changes go
 * through a leaf, which is reviewed, verified and durable.
 */
export const READ_VERBS = ['get', 'describe', 'logs', 'events', 'top'] as const;

/**
 * Resources worth reading, and the two that are deliberately missing.
 *
 * `secrets` and `configmaps` are not here. A Secret is the credential material this platform binds
 * into apps, and a ConfigMap routinely holds a connection string — reading either would hand a
 * model the thing every other boundary in this codebase exists to protect. Their absence from this
 * list is the enforcement; there is no second check to forget.
 */
export const READ_RESOURCES = [
  'pods', 'pod', 'po',
  'deployments', 'deployment', 'deploy',
  'replicasets', 'rs', 'statefulsets', 'sts', 'daemonsets', 'ds',
  'jobs', 'job', 'cronjobs',
  'services', 'service', 'svc', 'ingress', 'endpoints',
  'persistentvolumeclaims', 'pvc', 'persistentvolumes', 'pv',
  'events', 'ev',
  'nodes', 'node', 'no',
  'namespaces', 'namespace', 'ns',
] as const;

/** Resources with no namespace. Capacity and topology, never tenant data. */
const CLUSTER_SCOPED = new Set(['nodes', 'node', 'no', 'persistentvolumes', 'pv', 'namespaces', 'namespace', 'ns']);

export interface ReadRequest {
  verb: string;
  resource: string;
  /** A specific object, optional. Never a namespace — that is resolved, never accepted. */
  name?: string | undefined;
  /** The deployment or sandbox the caller named. Resolved against what they own. */
  target?: string | undefined;
}

export interface ReadPlan {
  argv: string[];
  namespace?: string;
}

/**
 * The namespaces a caller may read.
 *
 * Their deployments, as before — plus their own leaf sandboxes. "Why did my leaf fail" is the
 * question most worth answering and the one that used to require reading Mongo by hand: two
 * projects burned roughly 3.7M tokens on failures nobody could see into.
 *
 * Built from the platform's records rather than from the cluster, for the reason this file's header
 * gives: Kubernetes does not know who owns what, and asking it would be asking the wrong authority.
 */
export function readableNamespaces(
  deployments: readonly OwnedNamespace[],
  sandboxNamespaces: readonly string[],
  ownerId: string,
): string[] {
  return [
    ...deployments.filter((d) => d.ownerId === ownerId).map((d) => d.namespace),
    ...sandboxNamespaces,
  ];
}

/**
 * An argv array, or a refusal that says which rule stopped it.
 *
 * Refusals name the rule on purpose. A tool that fails opaquely reads to an agent as a broken tool
 * and gets retried; one that says "top is allowed, patch is not" is a boundary the agent can work
 * within — which is the same reason `renderSearchOutcome` distinguishes unavailable from empty.
 */
export function planRead(
  request: ReadRequest,
  allowed: readonly string[],
): ReadPlan | { refused: string } {
  const verb = String(request.verb ?? '').trim().toLowerCase();
  const resource = String(request.resource ?? '').trim().toLowerCase();

  if (!(READ_VERBS as readonly string[]).includes(verb)) {
    return { refused: `"${verb}" is not a readable action. Allowed: ${READ_VERBS.join(', ')}. `
      + 'Changing the cluster goes through a leaf, which is reviewed and verified.' };
  }
  if (!(READ_RESOURCES as readonly string[]).includes(resource)) {
    // Named explicitly, because "secrets" is the guess an agent makes next and a silent refusal
    // invites it to try configmaps instead.
    const secretish = ['secret', 'secrets', 'configmap', 'configmaps'].includes(resource);
    return { refused: secretish
      ? `Secrets and ConfigMaps cannot be read — they hold the credentials this platform binds into apps.`
      : `"${resource}" is not a readable resource. Allowed: ${READ_RESOURCES.slice(0, 12).join(', ')}…` };
  }

  // A name is an object within a namespace, never a namespace itself, and never a flag.
  const name = request.name && /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(request.name) ? request.name : undefined;
  if (request.name && !name) return { refused: `"${request.name}" is not a valid object name.` };

  if (CLUSTER_SCOPED.has(resource)) {
    // No namespace to scope, and nothing tenant-specific to leak: capacity and topology only.
    return { argv: [verb, resource, ...(name ? [name] : [])] };
  }

  const target = String(request.target ?? '').trim();
  if (!target) return { refused: 'Say which deployment or leaf sandbox to look at.' };
  /**
   * Matched against the resolved list, never used as a namespace directly. A namespace taken from a
   * tool call would read every other tenant's — the rule `namespaceFor` already states for logs.
   */
  const namespace = allowed.find((n) => n === target.toLowerCase()
    || n === target.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  if (!namespace) return { refused: `No deployment or sandbox of yours named "${target}".` };

  return { argv: [verb, resource, ...(name ? [name] : []), '-n', namespace], namespace };
}
