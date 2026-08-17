/**
 * Whether a deployed service ANSWERS, as opposed to merely running.
 *
 * ── WHY IT WAS HARD TO TELL ──
 * Two deployments both read `running`. One served three MCP tools; the other returned
 * `HTTP 404 from initialize` to every call. Nothing on screen distinguished them, and the person
 * who had just built both could not say which was which — reasonably, because the only signal
 * offered was a status that was true of both.
 *
 * The reconciliation loop asks Kubernetes whether the pod is up, and a pod serving 404s is up. That
 * is the same distinction this codebase draws everywhere else — `verified` versus `claimed`,
 * `failed` versus `unhealthy` — arriving one layer lower: the workload is placed and the service
 * does not work.
 *
 * ── WHAT THIS DOES NOT DO ──
 * It does not decide whether a service is CORRECT, only whether it speaks the protocol it is
 * offered under. A server answering `initialize` with a tool list is doing the one thing every
 * consumer of it assumes, and that is what the registry already probes for. Anything deeper belongs
 * to the acceptance checks.
 */

/** What a probe found. `undefined` means the probe could not be run at all. */
export interface ProbeResult {
  /** Why the service is unusable, when it is. Empty or absent means it answered. */
  unreachable?: string | undefined;
  /** How many tools it offered. Zero from a reachable server is still a broken MCP service. */
  tools: number;
}

/**
 * The health a probe implies, or undefined to leave the deployment alone.
 *
 * `undefined` is the load-bearing answer and covers three cases that must not become a status
 * change: no probe ran, the deployment is not the kind that can be probed, and the service is fine.
 * A reconciliation that guesses turns a momentary blip into a wave of false unhealthy marks, which
 * is worse than the stale record it replaces.
 */
export function healthFromProbe(probe: ProbeResult | undefined): { reason: string } | undefined {
  if (!probe) return undefined;
  if (probe.unreachable) return { reason: describeProbeFailure(probe.unreachable) };
  /**
   * Reachable and offering nothing is still broken, and is the more confusing failure of the two:
   * the pod is up, the port answers, and every agent granted the service finds no tools with
   * nothing saying why.
   */
  if (probe.tools === 0) return { reason: 'answers but offers no tools' };
  return undefined;
}

/**
 * The probe's own words, trimmed to something a status column can hold.
 *
 * Kept rather than replaced with a generic "unreachable": `HTTP 404 from initialize` and a
 * connection refusal are different problems with different fixes, and collapsing them sends someone
 * to the wrong place.
 */
export function describeProbeFailure(raw: string): string {
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}
