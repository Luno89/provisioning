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
