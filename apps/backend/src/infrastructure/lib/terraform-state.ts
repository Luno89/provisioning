export const stateFilesOf = (stackName: string): string[] => [`terraform.${stackName}.tfstate`, `terraform.${stackName}.tfstate.backup`];

export type TerraformStateHome = { kind: 'local'; dir: string } | { kind: 'kubernetes'; namespace: string; dir: string };

export function terraformStateFrom(env: Readonly<Record<string, string | undefined>>, dir: string): TerraformStateHome {
  const kind = env.TERRAFORM_STATE?.trim() || 'local';
  if (kind === 'local') return { kind, dir };
  if (kind !== 'kubernetes') throw new Error(`TERRAFORM_STATE is ${kind}; Koala keeps Terraform's state either local or in kubernetes`);
  const namespace = env.POD_NAMESPACE?.trim();
  if (!namespace) throw new Error('TERRAFORM_STATE is kubernetes, which keeps each stack\'s state in this pod\'s own namespace, but POD_NAMESPACE is not set');
  if (!env.KUBERNETES_SERVICE_HOST?.trim()) throw new Error('TERRAFORM_STATE is kubernetes, which reaches the cluster with the pod\'s own account, but this process is not running in a pod');
  return { kind, namespace, dir };
}

export const cdktfStateEnv = (home: TerraformStateHome): Record<string, string> =>
  (home.kind === 'kubernetes' ? { CDKTF_STATE_NAMESPACE: home.namespace } : { CDKTF_STATE_DIR: home.dir });

export const MIRRORED_PROVIDERS = [
  'registry.terraform.io/hashicorp/kubernetes',
  'registry.terraform.io/hashicorp/helm',
  'registry.terraform.io/hetznercloud/hcloud',
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
