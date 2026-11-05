import { Construct } from "constructs";
import { KubernetesProvider } from "../.gen/providers/kubernetes/provider/index.js";
import { HelmProvider } from "../.gen/providers/helm/provider/index.js";

export interface K8sProviderConfig {
  readonly kubeconfigPath?: string;
  readonly kubeconfigContext?: string;
  readonly host?: string;
  readonly token?: string;
  readonly clusterCaCertificate?: string;
}

/**
 * Service class to initialize Kubernetes and Helm providers consistently.
 * This pattern allows for dynamic cluster targeting without local kubeconfig files.
 */
export const SYSTEM_CLUSTER_NAME = "provisioning-lunorica";

export function providerConfigFrom(env: NodeJS.ProcessEnv): K8sProviderConfig {
  const inOwnCluster = !env.CLUSTER_NAME || env.CLUSTER_NAME === SYSTEM_CLUSTER_NAME;
  return {
    kubeconfigPath: env.KUBECONFIG,
    kubeconfigContext: env.KUBECONFIG_CONTEXT,
    ...(inOwnCluster ? { host: env.K8S_HOST, token: env.K8S_TOKEN, clusterCaCertificate: env.K8S_CA_CERT } : {}),
  };
}

export class K8sProviderService {
  /**
   * Initializes Kubernetes and Helm providers on the given scope.
   * By creating them without an alias, they become the "default" providers
   * for all resources within this stack.
   */
  static initialize(scope: Construct, config: K8sProviderConfig) {
    // 1. Initialize Kubernetes Provider
    new KubernetesProvider(scope, "kubernetes", {
      configPath: config.kubeconfigPath,
      configContext: config.kubeconfigContext,
      host: config.host,
      token: config.token,
      clusterCaCertificate: config.clusterCaCertificate,
    });

    // 2. Initialize Helm Provider linked to the K8s provider configuration
    new HelmProvider(scope, "helm", {
      kubernetes: {
        configPath: config.kubeconfigPath,
        configContext: config.kubeconfigContext,
        host: config.host,
        token: config.token,
        clusterCaCertificate: config.clusterCaCertificate,
      },
    });
  }

  /**
   * Factory method to initialize providers from environment variables.
   */
  static fromEnv(scope: Construct): void {
    this.initialize(scope, providerConfigFrom(process.env));
  }
}
