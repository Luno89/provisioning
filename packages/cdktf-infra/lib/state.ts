import { createHash } from "node:crypto";
import path from "node:path";
import { LocalBackend, TerraformBackend, TerraformRemoteState, TerraformStack, type App, type DataTerraformRemoteStateConfig } from "cdktf";
import type { Construct } from "constructs";

export const statePath = (dir: string, stackId: string): string => path.join(dir, `terraform.${stackId}.tfstate`);

const LABEL_LIMIT = 63;
const ENDING = "-state";

export function stateSecretSuffix(stackId: string): string {
  const plain = stackId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (plain === stackId && plain.length + ENDING.length <= LABEL_LIMIT) return `${plain}${ENDING}`;
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 8);
  const kept = plain.slice(0, LABEL_LIMIT - ENDING.length - hash.length - 1).replace(/-+$/, "");
  return `${kept ? `${kept}-` : ""}${hash}${ENDING}`;
}

export interface KubernetesBackendConfig {
  readonly secretSuffix: string;
  readonly namespace: string;
}

export class KubernetesBackend extends TerraformBackend {
  constructor(scope: Construct, private readonly props: KubernetesBackendConfig) {
    super(scope, "backend", "kubernetes");
  }

  private attributes(): Record<string, unknown> {
    return { secret_suffix: this.props.secretSuffix, namespace: this.props.namespace, in_cluster_config: true };
  }

  protected synthesizeAttributes(): Record<string, unknown> {
    return this.attributes();
  }

  protected synthesizeHclAttributes(): Record<string, unknown> {
    return this.attributes();
  }

  getRemoteStateDataSource(scope: Construct, name: string): TerraformRemoteState {
    return new DataTerraformRemoteStateKubernetes(scope, name, { ...this.attributes(), workspace: "${terraform.workspace}" });
  }
}

export class DataTerraformRemoteStateKubernetes extends TerraformRemoteState {
  constructor(scope: Construct, id: string, config: DataTerraformRemoteStateConfig & Record<string, unknown>) {
    super(scope, id, "kubernetes", config);
  }
}

export interface StateHome {
  CDKTF_STATE_DIR?: string | undefined;
  CDKTF_STATE_NAMESPACE?: string | undefined;
}

export function keepState(app: App, home: StateHome): void {
  for (const child of app.node.children) {
    if (!(child instanceof TerraformStack)) continue;
    if (home.CDKTF_STATE_NAMESPACE) new KubernetesBackend(child, { secretSuffix: stateSecretSuffix(child.node.id), namespace: home.CDKTF_STATE_NAMESPACE });
    else if (home.CDKTF_STATE_DIR) new LocalBackend(child, { path: statePath(home.CDKTF_STATE_DIR, child.node.id) });
  }
}
