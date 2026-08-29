import { clusterHost } from './cluster-dns.js';
import {
  bindingTypeFor,
  type Binding,
  type ServiceBindingContract,
  PLATFORM_SERVICE_CONTRACTS,
} from './service-binding.js';
import type { BindingTypeRecord } from './db-interface.js';
import type { AppSpec } from './app-spec.js';

export interface BindingRequest {
  service: string;
  as?: string;
}

export interface CredentialSource {
  secretName: string;
  namespace: string;
  keys: Record<string, string>;
}

export interface ResolvedBinding {
  name: string;
  type: string;
  host: string;
  port: number;
  protocol?: string | undefined;
  source: CredentialSource;
}

export interface Resolution {
  bindings: ResolvedBinding[];
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
      problems.push(`No service named "${wanted}".`);
      continue;
    }
    if (found && found.status && found.status !== 'running') {
      problems.push(`"${wanted}" is not running (${found.status ?? 'unknown'}).`);
      continue;
    }

    const contract = found?.bindingContract ?? platformContract;
    if (contract) {
      const type = contract.bindingType;
      const name = String(need.as ?? wanted).trim() || wanted;
      if (taken.has(name)) {
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
      problems.push(`"${wanted}" was not created from an app spec, so its connection details are not known.`);
      continue;
    }

    const name = String(need.as ?? appType).trim() || appType;
    if (taken.has(name)) {
      problems.push(`Two bindings are both named "${name}" — give one an "as" name.`);
      continue;
    }
    taken.add(name);

    const namespace = namespaceOf(found!.name);
    const matchedRecord = options?.dynamicTypes?.find((dt) => dt.appType === appType || dt.id === appType);
    bindings.push({
      name,
      type,
      host: clusterHost(appType, namespace),
      port,
      ...(matchedRecord?.protocol ? { protocol: matchedRecord.protocol } : {}),
      source: {
        secretName: `${spec.id}-secret`,
        namespace,
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

export function bindingFiles(
  binding: ResolvedBinding,
  credentials: Record<string, string>,
): Record<string, string> {
  return {
    type: binding.type,
    host: binding.host,
    port: String(binding.port),
    ...(binding.protocol ? { protocol: binding.protocol } : {}),
    ...Object.fromEntries(
      Object.keys(binding.source.keys)
        .filter((k) => credentials[k] !== undefined)
        .map((k) => [k, credentials[k] as string]),
    ),
  };
}
