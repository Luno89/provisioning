import { App, TerraformStack } from "cdktf";
import { Construct } from "constructs";
import { BaseCluster } from "./constructs/cluster.js";
import { OdooApp } from "./constructs/odoo.js";
import { OdooNativeApp } from "./constructs/odoo-native.js";
import { MonitoringStack } from "./constructs/monitoring.js";
import { K8sProviderService } from "./lib/k8s-provider-service.js";

export interface ClusterStackConfig {
  environment: "local" | "k3d" | "aws" | "gcp" | "azure" | "do";
  name: string;
}

/**
 * ClusterStack manages the infrastructure provisioning (e.g. k3d, EKS).
 */
class ClusterStack extends TerraformStack {
  constructor(scope: Construct, id: string, config: ClusterStackConfig) {
    super(scope, id);

    const isLocal = config.environment === "local" || config.environment === "k3d";
    const kubeconfig = process.env.KUBECONFIG_PATH || (isLocal ? "~/.kube/config" : `/tmp/kubeconfig-${config.name}`);
    const context = isLocal ? `k3d-${config.name}` : undefined;

    K8sProviderService.initialize(this, {
      kubeconfigPath: kubeconfig,
      kubeconfigContext: context,
    });

    new BaseCluster(this, "cluster", {
      environment: config.environment,
      name: config.name,
    });

    new MonitoringStack(this, "monitoring");
  }
}

/**
 * AppStack manages the deployment of applications on a provisioned cluster.
 */
class AppStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    
    K8sProviderService.fromEnv(this);

    const strategy = process.env.DEPLOYMENT_STRATEGY || 'helm';
    // Unique name for isolation (namespace and resource prefixing)
    const deploymentName = process.env.DEPLOYMENT_NAME || 'odoo';

    if (strategy === 'native') {
      new OdooNativeApp(this, "odoo-native", {
        namespace: deploymentName,
        odooRepo: process.env.ODOO_IMAGE_REPO,
        odooTag: process.env.ODOO_IMAGE_TAG,
        pgRepo: process.env.POSTGRES_IMAGE_REPO,
        pgTag: process.env.POSTGRES_IMAGE_TAG,
        enabledModules: process.env.ENABLED_MODULES,
        gitRepoPath: process.env.GIT_REPO_PATH,
      });
    } else {
      new OdooApp(this, "odoo-app", {
        namespace: deploymentName,
        odooRepo: process.env.ODOO_IMAGE_REPO,
        odooTag: process.env.ODOO_IMAGE_TAG,
        pgRepo: process.env.POSTGRES_IMAGE_REPO,
        pgTag: process.env.POSTGRES_IMAGE_TAG,
      });
    }
  }
}

const app = new App();

const stackType = process.env.STACK_TYPE;
const clusterName = process.env.CLUSTER_NAME || "dev-cluster";
// For AppStack, we use a unique ID per deployment for state isolation
const deploymentId = process.env.DEPLOYMENT_ID || 'default';

if (stackType === "cluster") {
  const env = process.env.ENV as ClusterStackConfig["environment"];
  new ClusterStack(app, clusterName, { environment: env, name: clusterName });
} else if (stackType === "app") {
  // Use deploymentId in the stack name to allow multiple deployments on the same cluster
  new AppStack(app, `app-${clusterName}-${deploymentId}`);
}

app.synth();
