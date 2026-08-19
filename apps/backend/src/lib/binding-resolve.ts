import { clusterHost } from './cluster-dns.js';
import { bindingTypeFor } from './service-binding.js';
import type { AppSpec } from './app-spec.js';

/**
 * Working out what a project's declared dependencies actually resolve to.
 *
 * ── WHY THE OWNERSHIP CHECK IS THE WHOLE POINT ──
 * Kubernetes Secrets are namespace-scoped and there is no supported cross-namespace reference, so
 * binding one service to another means the platform READS a Secret in one namespace and writes
 * something derived from it into another. That is exactly the shape of the vulnerability class
 * described in "Breaking the Bulkhead" (arxiv 2507.03387): operators whose implemented scope is
 * wider than their declared scope let one namespace reach another's secrets.
 *
 * So the ownership filter here is not a nicety layered on top of the feature — it IS the feature's
 * security boundary, and it is applied to the source deployments before anything is matched, not to
 * the results afterwards. A name that belongs to someone else must be indistinguishable from a name
 * that does not exist, which is why both produce the same refusal.
 *
 * ── AND WHY THIS FILE IS PURE ──
 * It reads no cluster and holds no credential. It decides WHICH secret may be read and what the
 * binding will be called; the reading happens in the deploy path. Keeping the decision separate
 * from the act is what lets the security property be tested exhaustively without a cluster.
 */

/** A service a project says it needs. */
export interface BindingRequest {
  /** The deployment's name, as `list_infrastructure` reports it. */
  service: string;
  /** Directory name under $SERVICE_BINDING_ROOT. Defaults to the service's app type. */
  as?: string;
}

/** Where a credential is to be read from, and what it becomes in the binding. */
export interface CredentialSource {
  /** The Secret holding it, in the PROVIDER's namespace. */
  secretName: string;
  namespace: string;
  /** Binding key (`username`) → the source Secret's key (`mongo-root-username`). */
  keys: Record<string, string>;
}

export interface ResolvedBinding {
  /** Directory under $SERVICE_BINDING_ROOT. */
  name: string;
  /** The spec's required `type` file. */
  type: string;
  host: string;
  port: number;
  source: CredentialSource;
}

export interface Resolution {
  bindings: ResolvedBinding[];
  /** Why a request could not be met. Reported, never thrown — one bad name must not fail a deploy. */
  problems: string[];
}

interface DeploymentLike {
  name: string;
  appType?: string | undefined;
  status?: string | undefined;
  ownerId?: string | undefined;
}

interface StoredSpecLike {
  id: string;
  spec: AppSpec;
}

const namespaceOf = (name: string) => String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-');

/**
 * What a project's `needs` resolve to, for a given owner.
 *
 * `ownerId` is the caller's, and the filter is applied FIRST. Everything after that operates on a
 * list that contains only their deployments, so there is no path where a later condition could let
 * one through.
 */
export function resolveBindings(
  needs: readonly BindingRequest[],
  deployments: readonly DeploymentLike[],
  specs: readonly StoredSpecLike[],
  ownerId: string,
): Resolution {
  // Applied before anything is matched. A narrower list cannot be widened by a later mistake.
  const mine = deployments.filter((d) => d.ownerId === ownerId);
  const byId = new Map(specs.map((s) => [s.id, s.spec]));

  const bindings: ResolvedBinding[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();

  for (const need of needs) {
    const wanted = String(need.service ?? '').trim();
    if (!wanted) continue;

    const found = mine.find((d) => d.name === wanted || namespaceOf(d.name) === namespaceOf(wanted));
    if (!found) {
      /**
       * Deliberately the same message whether it belongs to someone else or does not exist. A
       * distinct "that is not yours" would confirm the name is real, which is a probe.
       */
      problems.push(`No service named "${wanted}".`);
      continue;
    }
    if (found.status !== 'running') {
      // Binding to something not running would hand an app an address that answers nothing, and the
      // failure would look like a network problem rather than a missing dependency.
      problems.push(`"${wanted}" is not running (${found.status ?? 'unknown'}).`);
      continue;
    }

    const appType = String(found.appType ?? '');
    const type = bindingTypeFor(appType);
    if (!type) {
      problems.push(`"${wanted}" is a ${appType || 'unknown'}, which is not a service another app binds to.`);
      continue;
    }

    const spec = byId.get(appType);
    const port = spec?.ports?.[0]?.port;
    if (!spec || port === undefined) {
      /**
       * Only spec-deployed services can be bound. A construct names its Service and its Secret its
       * own way, and guessing either would produce a binding pointing at nothing — the same reason
       * `list_infrastructure` reports no address for one.
       */
      problems.push(`"${wanted}" was not created from an app spec, so its connection details are not known.`);
      continue;
    }

    const name = String(need.as ?? appType).trim() || appType;
    if (taken.has(name)) {
      // Two bindings in one directory would overwrite each other's files.
      problems.push(`Two bindings are both named "${name}" — give one an "as" name.`);
      continue;
    }
    taken.add(name);

    const namespace = namespaceOf(found.name);
    bindings.push({
      name,
      type,
      // Derived, never invented — see cluster-dns.ts.
      host: clusterHost(appType, namespace),
      port,
      source: {
        // renderApp names it `<specId>-secret`; this must agree with it or the read finds nothing.
        secretName: `${spec.id}-secret`,
        namespace,
        /**
         * Mapped exactly, not guessed. The spec's `generate` field already says whether a value is
         * the username or the password, so `mongo-root-username` → `username` is a fact rather than
         * a heuristic on the key's name.
         */
        keys: Object.fromEntries(
          (spec.env ?? [])
            .filter((e) => e.fromSecret && e.generate)
            .map((e) => [e.generate as string, e.fromSecret as string]),
        ),
      },
    });
  }

  return { bindings, problems };
}

/**
 * The files a binding becomes, given the credentials read from its source.
 *
 * The spec's shape: `type` is required, then whatever else the service needs. Credentials are passed
 * in rather than read here, so this stays pure and a test can prove which keys cross without a
 * cluster.
 */
export function bindingFiles(
  binding: ResolvedBinding,
  credentials: Record<string, string>,
): Record<string, string> {
  return {
    type: binding.type,
    host: binding.host,
    port: String(binding.port),
    // Only the keys the binding declared. Anything else in the source Secret stays there — a
    // binding is not a copy of a service's secrets, it is the subset needed to connect.
    ...Object.fromEntries(
      Object.keys(binding.source.keys)
        .filter((k) => credentials[k] !== undefined)
        .map((k) => [k, credentials[k] as string]),
    ),
  };
}
