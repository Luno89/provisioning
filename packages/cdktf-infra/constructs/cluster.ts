import { Construct } from "constructs";
import { TerraformOutput } from "cdktf";

export interface ClusterConfig {
  readonly environment: "local" | "k3d" | "aws" | "gcp" | "azure" | "do" | "remote" | "hetzner";
  readonly name: string;
}

export type ClusterEnvironment = ClusterConfig["environment"];

export const MADE_HERE: readonly ClusterEnvironment[] = ["local", "k3d"];

export const BOOTSTRAPPED_ELSEWHERE: readonly ClusterEnvironment[] = ["remote", "hetzner", "do"];

export const clusterBuilt = (environment: string): boolean =>
  (MADE_HERE as readonly string[]).includes(environment) || (BOOTSTRAPPED_ELSEWHERE as readonly string[]).includes(environment);

export class BaseCluster extends Construct {
  public readonly kubeconfigPath: TerraformOutput;

  constructor(scope: Construct, id: string, config: ClusterConfig) {
    super(scope, id);

    const isLocal = MADE_HERE.includes(config.environment);
    const kubeconfig = process.env.KUBECONFIG_PATH || (isLocal ? "~/.kube/config" : `/tmp/kubeconfig-${config.name}`);

    // 'remote', 'hetzner' and 'do' need nothing here: by the time this stack is applied, k3s is already
    // running on the target machine and `kubeconfig` above points at it. (For 'hetzner' the VM
    // itself was created by HetznerVmStack in a strictly earlier apply, for 'do' through DigitalOcean's
    // API; for 'remote' the machine already existed.) The remaining providers are still the original stubs — see the
    // distributed-systems plan on why the "multi-cloud" story was scaffolding, not a feature.
    if (!clusterBuilt(config.environment)) {
      console.log(`${config.environment.toUpperCase()} Cluster logic would be instantiated here.`);
    }

    this.kubeconfigPath = new TerraformOutput(this, "kubeconfig_path", {
      value: kubeconfig,
    });
  }
}
