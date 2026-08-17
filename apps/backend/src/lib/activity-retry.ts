/**
 * How many times an activity is worth retrying.
 *
 * ── WHY THIS FILE EXISTS ──
 * Temporal's default is UNLIMITED, and that default turned one bad Dockerfile into a total outage.
 *
 * Measured: a project's Dockerfile copied `package.json` without `package-lock.json` and then ran
 * `npm ci`, which cannot work. `DeployAppActivity` retried it **54 times over ninety minutes**,
 * holding the cluster worker's activity slot the entire time. Five pipeline runs queued behind it
 * and never started — including the ones that would have replaced the broken image. From outside,
 * the system looked hung; nothing had crashed, one activity was simply retrying forever and
 * starving the queue.
 *
 * Two workflows already set a bound and said why (ClusterProvisionWorkflow, DestroyClusterWorkflow).
 * The rest inherited the default, which is how a deliberate decision in two files became an
 * accident in six.
 *
 * ── WHY THESE NUMBERS ──
 * The question a retry answers is "was that transient?". A kubectl call that lost its connection is
 * worth repeating; a build whose Dockerfile cannot succeed is not, and no number of attempts will
 * change it. Three is enough to ride out a restart or a flapping API server and few enough that a
 * genuine misconfiguration surfaces in a minute rather than an afternoon.
 *
 * Destroys get more, for the reason DestroyClusterWorkflow already gives: a destroy that gives up
 * leaves paid-for infrastructure running, so the cost of one more attempt is lower than the cost of
 * stopping.
 */

/** Ordinary work: apply, build, deploy, check. Three attempts, then say so. */
export const ACTIVITY_ATTEMPTS = 3;

/** Teardown. Failing to destroy costs money for as long as it stays failed. */
export const DESTROY_ATTEMPTS = 5;

/**
 * The retry policy for anything that touches a cluster.
 *
 * The backoff matters as much as the cap: 54 attempts at a one-second interval is a hot loop
 * against an API server, and the first thing anybody does when a system looks hung is look for the
 * thing hammering it.
 */
export const ACTIVITY_RETRY = {
  maximumAttempts: ACTIVITY_ATTEMPTS,
  initialInterval: '2s',
  backoffCoefficient: 2,
  maximumInterval: '30s',
} as const;

export const DESTROY_RETRY = {
  maximumAttempts: DESTROY_ATTEMPTS,
  initialInterval: '2s',
  backoffCoefficient: 2,
  maximumInterval: '30s',
} as const;
