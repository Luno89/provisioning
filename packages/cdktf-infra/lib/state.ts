import path from "node:path";
import { LocalBackend, TerraformBackend, TerraformRemoteState, TerraformStack, type App, type DataTerraformRemoteStateConfig } from "cdktf";
import type { Construct } from "constructs";
import { stateSecretSuffix } from "./state-name.js";

export const statePath = (dir: string, stackId: string): string => path.join(dir, `terraform.${stackId}.tfstate`);

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
