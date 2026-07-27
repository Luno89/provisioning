/**
 * Cluster name validation.
 *
 * A cluster's name is not just a label. `ClusterService.getPhysicalClusterName()` returns it
 * verbatim for real clusters, and that string then becomes:
 *
 *   - a CDKTF `TerraformStack` id, which rejects whitespace outright
 *   - a k3d cluster name, and the `k3d-<name>` kubeconfig context derived from it
 *   - a Hetzner server name
 *   - the kubeconfig path `/tmp/kubeconfig-<name>`
 *   - Kubernetes object names, which are RFC 1123 labels: lowercase alphanumerics and '-' only,
 *     starting and ending alphanumeric
 *
 * So the narrowest of those — the RFC 1123 label — is the rule for all of them. Names are
 * REJECTED rather than silently rewritten: `clusters` has a unique index on `name`, so quietly
 * folding "VPS -test" and "vps_test" onto the same `vps-test` would turn a typo into a collision
 * against someone else's cluster. The suggestion is offered to the user instead of applied.
 */

/**
 * 40 leaves headroom in the 63-character RFC 1123 label budget for every prefix the platform adds
 * downstream — `mock-scaleway-` is 14, and k3d derives `k3d-<name>-server-0` on top of that.
 */
export const CLUSTER_NAME_MAX_LENGTH = 40;

/** The always-on management cluster. A user cluster with this name would collide with it. */
const RESERVED_NAMES = new Set(['provisioning-lunorica']);

const VALID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface ClusterNameCheck {
  ok: boolean;
  /** Human-readable reason, present when ok is false. */
  error?: string;
  /** A valid name derived from the input, when one can be salvaged. */
  suggestion?: string;
}

/** Best-effort conversion of arbitrary text into a valid name. May return '' if nothing survives. */
export function suggestClusterName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CLUSTER_NAME_MAX_LENGTH)
    .replace(/-+$/, '');
}

export function validateClusterName(raw: unknown): ClusterNameCheck {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'A cluster name is required.' };
  }

  const name = raw.trim();
  const suggestion = suggestClusterName(name);
  const withSuggestion = (error: string): ClusterNameCheck =>
    suggestion && suggestion !== name ? { ok: false, error, suggestion } : { ok: false, error };

  if (name.length > CLUSTER_NAME_MAX_LENGTH) {
    return withSuggestion(`Cluster names must be ${CLUSTER_NAME_MAX_LENGTH} characters or fewer (this one is ${name.length}).`);
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: `"${name}" is reserved for the management cluster. Pick a different name.` };
  }
  if (/\s/.test(name)) {
    // Called out separately because it is by far the most common rejection and the generic
    // character message reads as pedantic for something as ordinary as a space.
    return withSuggestion('Cluster names cannot contain spaces.');
  }
  if (!VALID.test(name)) {
    return withSuggestion(
      'Cluster names may use only lowercase letters, numbers and hyphens, and must start and end with a letter or number.',
    );
  }
  return { ok: true };
}
