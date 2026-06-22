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

    let kubeconfig = "";

    const isLocal = config.environment === "local" || config.environment === "k3d";
    if (isLocal) {
      kubeconfig = `~/.kube/config`;
      // Providers are now handled at the Stack level
    } else {
      kubeconfig = `/tmp/kubeconfig-${config.name}`;
      console.log(`${config.environment.toUpperCase()} Cluster logic would be instantiated here.`);
    }

    this.kubeconfigPath = new TerraformOutput(this, "kubeconfig_path", {
      value: kubeconfig,
    });
  }
}
