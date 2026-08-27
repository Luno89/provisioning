import { clusterHost } from './cluster-dns.js';
import {
  bindingTypeFor,
  type Binding,
  type ServiceBindingContract,
  PLATFORM_SERVICE_CONTRACTS,
} from './service-binding.js';
import type { BindingTypeRecord } from './db-interface.js';
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
  protocol?: string | undefined;
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
  bindingContract?: ServiceBindingContract | undefined;
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
 * list that contains only their deployments or shared platform services, so there is no path where
 * a later condition could let an unauthorised private deployment through.
 */
export function resolveBindings(
  needs: readonly BindingRequest[],
  deployments: readonly DeploymentLike[],
  specs: readonly StoredSpecLike[],
  ownerId: string,
  options?: {
    dynamicTypes?: readonly BindingTypeRecord[];
    contracts?: Record<string, ServiceBindingContract>;
  },
): Resolution {
  // Applied before anything is matched. Tenant isolation: only own deployments or platform services (no ownerId).
  const mine = deployments.filter((d) => !d.ownerId || d.ownerId === ownerId);
  const byId = new Map(specs.map((s) => [s.id, s.spec]));

  const bindings: ResolvedBinding[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();

  for (const need of needs) {
    const wanted = String(need.service ?? '').trim();
    if (!wanted) continue;

    const found = mine.find((d) => d.name === wanted || namespaceOf(d.name) === namespaceOf(wanted));
    const platformContract = options?.contracts?.[wanted]
      ?? PLATFORM_SERVICE_CONTRACTS[wanted]
      ?? (found?.appType ? PLATFORM_SERVICE_CONTRACTS[found.appType] : undefined);

    if (!found && !platformContract) {
      /**
       * Deliberately the same message whether it belongs to someone else or does not exist. A
       * distinct "that is not yours" would confirm the name is real, which is a probe.
       */
      problems.push(`No service named "${wanted}".`);
      continue;
    }
    if (found && found.status && found.status !== 'running') {
      // Binding to something not running would hand an app an address that answers nothing, and the
      // failure would look like a network problem rather than a missing dependency.
      problems.push(`"${wanted}" is not running (${found.status ?? 'unknown'}).`);
      continue;
    }

    const contract = found?.bindingContract ?? platformContract;
    if (contract) {
      const type = contract.bindingType;
      const name = String(need.as ?? wanted).trim() || wanted;
      if (taken.has(name)) {
        // Two bindings in one directory would overwrite each other's files.
        problems.push(`Two bindings are both named "${name}" — give one an "as" name.`);
        continue;
      }
      taken.add(name);

      bindings.push({
        name,
        type,
        host: clusterHost(contract.serviceName, contract.namespace),
        port: contract.port,
        ...(contract.protocol ? { protocol: contract.protocol } : {}),
        source: {
          secretName: contract.secretName ?? `${contract.serviceName}-secret`,
          namespace: contract.namespace,
          keys: contract.keyMapping ?? {},
        },
      });
      continue;
    }

    const appType = String(found?.appType ?? '');
    const type = bindingTypeFor(appType, options?.dynamicTypes);
    if (!type) {
      problems.push(`"${wanted}" is a ${appType || 'unknown'}, which is not a service another app binds to.`);
      continue;
    }

    const spec = byId.get(appType);
    const port = spec?.ports?.[0]?.port;
    if (!spec || port === undefined) {
      /**
       * Only spec-deployed services or contract-declared services can be bound.
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

    const namespace = namespaceOf(found!.name);
    const matchedRecord = options?.dynamicTypes?.find((dt) => dt.appType === appType || dt.id === appType);
    bindings.push({
      name,
      type,
      // Derived, never invented — see cluster-dns.ts.
      host: clusterHost(appType, namespace),
      port,
      ...(matchedRecord?.protocol ? { protocol: matchedRecord.protocol } : {}),
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
 * A resolved binding as the agent-facing description wants it.
 *
 * The two shapes differ in exactly one field and for a good reason: `ResolvedBinding.source.keys`
 * maps a binding key to the SOURCE Secret's key, which is an internal fact, while `Binding.keys` is
 * the list of filenames the agent will find. Converting here rather than at each call site keeps
 * the source mapping from reaching a prompt.
 */
export function describable(binding: ResolvedBinding): Binding {
  return {
    name: binding.name,
    type: binding.type,
    host: binding.host,
    port: binding.port,
    ...(binding.protocol ? { protocol: binding.protocol } : {}),
    keys: Object.keys(binding.source.keys),
  };
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
    ...(binding.protocol ? { protocol: binding.protocol } : {}),
    // Only the keys the binding declared. Anything else in the source Secret stays there — a
    // binding is not a copy of a service's secrets, it is the subset needed to connect.
    ...Object.fromEntries(
      Object.keys(binding.source.keys)
        .filter((k) => credentials[k] !== undefined)
        .map((k) => [k, credentials[k] as string]),
    ),
  };
}
