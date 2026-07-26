import { Construct } from "constructs";
import { TerraformOutput } from "cdktf";

export interface ClusterConfig {
  readonly environment: "local" | "k3d" | "aws" | "gcp" | "azure" | "do" | "remote" | "hetzner";
  readonly name: string;
}

export class BaseCluster extends Construct {
  public readonly kubeconfigPath: TerraformOutput;

  constructor(scope: Construct, id: string, config: ClusterConfig) {
    super(scope, id);

    const isLocal = config.environment === "local" || config.environment === "k3d";
    const kubeconfig = process.env.KUBECONFIG_PATH || (isLocal ? "~/.kube/config" : `/tmp/kubeconfig-${config.name}`);

    // 'remote' and 'hetzner' need nothing here: by the time this stack is applied, k3s is already
    // running on the target machine and `kubeconfig` above points at it. (For 'hetzner' the VM
    // itself was created by HetznerVmStack in a strictly earlier apply; for 'remote' the machine
    // already existed.) The remaining providers are still the original stubs — see the
    // distributed-systems plan on why the "multi-cloud" story was scaffolding, not a feature.
    const isBootstrappedElsewhere = config.environment === "remote" || config.environment === "hetzner";
    if (!isLocal && !isBootstrappedElsewhere) {
      console.log(`${config.environment.toUpperCase()} Cluster logic would be instantiated here.`);
    }

    this.kubeconfigPath = new TerraformOutput(this, "kubeconfig_path", {
      value: kubeconfig,
    });
  }
}
