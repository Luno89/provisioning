import { Construct } from "constructs";
import { TerraformOutput } from "cdktf";

export interface ClusterConfig {
  readonly environment: "local" | "k3d" | "aws" | "gcp" | "azure" | "do";
  readonly name: string;
}

export class BaseCluster extends Construct {
  public readonly kubeconfigPath: TerraformOutput;

  constructor(scope: Construct, id: string, config: ClusterConfig) {
    super(scope, id);

    const isLocal = config.environment === "local" || config.environment === "k3d";
    const kubeconfig = process.env.KUBECONFIG_PATH || (isLocal ? "~/.kube/config" : `/tmp/kubeconfig-${config.name}`);

    if (!isLocal) {
      console.log(`${config.environment.toUpperCase()} Cluster logic would be instantiated here.`);
    }

    this.kubeconfigPath = new TerraformOutput(this, "kubeconfig_path", {
      value: kubeconfig,
    });
  }
}
