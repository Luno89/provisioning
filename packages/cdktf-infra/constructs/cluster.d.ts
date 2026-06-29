import { Construct } from "constructs";
import { TerraformOutput } from "cdktf";
export interface ClusterConfig {
    readonly environment: "local" | "k3d" | "aws" | "gcp" | "azure" | "do";
    readonly name: string;
}
export declare class BaseCluster extends Construct {
    readonly kubeconfigPath: TerraformOutput;
    constructor(scope: Construct, id: string, config: ClusterConfig);
}
//# sourceMappingURL=cluster.d.ts.map