import { Construct } from "constructs";
import { TerraformOutput } from "cdktf";
export class BaseCluster extends Construct {
    kubeconfigPath;
    constructor(scope, id, config) {
        super(scope, id);
        let kubeconfig = "";
        const isLocal = config.environment === "local" || config.environment === "k3d";
        if (isLocal) {
            kubeconfig = `~/.kube/config`;
            // Providers are now handled at the Stack level
        }
        else {
            kubeconfig = `/tmp/kubeconfig-${config.name}`;
            console.log(`${config.environment.toUpperCase()} Cluster logic would be instantiated here.`);
        }
        this.kubeconfigPath = new TerraformOutput(this, "kubeconfig_path", {
            value: kubeconfig,
        });
    }
}
