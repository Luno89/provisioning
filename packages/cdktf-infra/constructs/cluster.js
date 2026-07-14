import { Construct } from "constructs";
import { TerraformOutput } from "cdktf";
export class BaseCluster extends Construct {
    kubeconfigPath;
    constructor(scope, id, config) {
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
