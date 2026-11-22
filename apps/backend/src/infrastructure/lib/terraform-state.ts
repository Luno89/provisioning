import { stateSecretName } from 'cdktf-infra/state-name';

export const stateFilesOf =(stackName: string): string[] => [`terraform.${stackName}.tfstate`, `terraform.${stackName}.tfstate.backup`];

export interface KubernetesApi {
  host: string;
  port: string;
}

export type TerraformStateKind = { kind: 'local' } | { kind: 'kubernetes'; namespace: string; api: KubernetesApi };

export type TerraformStateHome = { kind: 'local'; dir: string } | { kind: 'kubernetes'; namespace: string; api: KubernetesApi; dir: string };

export function terraformStateFrom(env: Readonly<Record<string, string | undefined>>): TerraformStateKind {
  const kind = env.TERRAFORM_STATE?.trim();
  if (!kind) throw new Error('TERRAFORM_STATE is not set: it says where Terraform keeps each stack\'s state, local (in the data folder) or kubernetes (in this pod\'s namespace)');
  if (kind === 'local') return { kind };
  if (kind !== 'kubernetes') throw new Error(`TERRAFORM_STATE is ${kind}; Koala keeps Terraform's state either local or in kubernetes`);
  const namespace = env.POD_NAMESPACE?.trim();
  if (!namespace) throw new Error('TERRAFORM_STATE is kubernetes, which keeps each stack\'s state in this pod\'s own namespace, but POD_NAMESPACE is not set');
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim();
  if (!host || !port) throw new Error('TERRAFORM_STATE is kubernetes, which reaches the cluster with the pod\'s own account, but this process is not running in a pod');
  return { kind, namespace, api: { host, port } };
}

export const stateHomeIn = (kind: TerraformStateKind, dir: string): TerraformStateHome => ({ ...kind, dir });

export const cdktfStateEnv = (home: TerraformStateHome): Record<string, string> =>
  (home.kind === 'kubernetes'
    ? { CDKTF_STATE_NAMESPACE: home.namespace, KUBERNETES_SERVICE_HOST: home.api.host, KUBERNETES_SERVICE_PORT: home.api.port }
    : { CDKTF_STATE_DIR: home.dir });

export const STATE_LOCK_INFO = 'app.terraform.io/lock-info';

export const stateLockName = (stackName: string): string => `lock-${stateSecretName(stackName)}`;

export interface StateLock {
  id: string;
  who: string;
  host?: string | undefined;
}

interface LeaseShape {
  metadata?: { annotations?: Record<string, string> | undefined; [field: string]: unknown } | undefined;
  spec?: { holderIdentity?: string | undefined; [field: string]: unknown } | undefined;
  [field: string]: unknown;
}

const whoOf = (info: string | undefined): string => {
  if (!info) return '';
  try {
    const who = (JSON.parse(info) as { Who?: unknown }).Who;
    return typeof who === 'string' ? who : '';
  } catch {
    return '';
  }
};

export function stateLockOf(lease: unknown): StateLock | undefined {
  const { metadata, spec } = lease as LeaseShape;
  const id = spec?.holderIdentity;
  if (!id) return undefined;
  const who = whoOf(metadata?.annotations?.[STATE_LOCK_INFO]);
  const at = who.lastIndexOf('@');
  const host = at >= 0 ? who.slice(at + 1) : '';
  return { id, who, ...(host ? { host } : {}) };
}

export function lockHolderGone(lock: StateLock, seen: { here: string; applyingHere: boolean; holderPodThere: boolean }): boolean {
  if (!lock.host) return false;
  return lock.host === seen.here ? !seen.applyingHere : !seen.holderPodThere;
}

export function freedLease(lease: unknown): unknown {
  const { metadata, spec, ...rest } = lease as LeaseShape;
  const annotations = Object.fromEntries(Object.entries(metadata?.annotations ?? {}).filter(([key]) => key !== STATE_LOCK_INFO));
  const keptSpec = Object.fromEntries(Object.entries(spec ?? {}).filter(([key]) => key !== 'holderIdentity'));
  return { ...rest, metadata: { ...metadata, annotations }, spec: keptSpec };
}

export const MIRRORED_PROVIDERS = [
  'registry.terraform.io/hashicorp/kubernetes',
  'registry.terraform.io/hashicorp/helm',
] as const;

const hclList = (items: readonly string[]): string => `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;

export function terraformCliConfig(mirror: string): string {
  return [
    'provider_installation {',
    '  filesystem_mirror {',
    `    path    = ${JSON.stringify(mirror)}`,
    `    include = ${hclList(MIRRORED_PROVIDERS)}`,
    '  }',
    '  direct {',
    `    exclude = ${hclList(MIRRORED_PROVIDERS)}`,
    '  }',
    '}',
    '',
  ].join('\n');
}

interface StateSnapshot {
  lineage?: unknown;
  serial?: unknown;
  resources?: unknown;
}

const snapshotOf = (text: string, what: string): StateSnapshot => {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as StateSnapshot;
  } catch {
    throw new Error(`${what} is not a Terraform state`);
  }
};

const holdsResources = (state: StateSnapshot): boolean => Array.isArray(state.resources) && state.resources.length > 0;

export type StateMove = { step: 'push' } | { step: 'forget' } | { step: 'refuse'; reason: string };

export function stateMove(stackName: string, local: string, remote: string): StateMove {
  const kept = snapshotOf(local, `the state ${stackName} kept in the data folder`);
  const there = snapshotOf(remote, `the state of ${stackName} in the cluster`);
  if (!holdsResources(kept)) return { step: 'forget' };
  if (!holdsResources(there)) return { step: 'push' };
  if (there.lineage === kept.lineage && Number(there.serial) >= Number(kept.serial)) return { step: 'forget' };
  return {
    step: 'refuse',
    reason: `${stackName} has a state in the data folder and another in the cluster that is not where that one led (lineage ${String(kept.lineage)} serial ${String(kept.serial)} there, ${String(there.lineage)} serial ${String(there.serial)} in the cluster); move one aside by hand before it runs again`,
  };
}
