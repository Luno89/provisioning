import { KubernetesProvider } from "../.gen/providers/kubernetes/provider/index.js";
import { HelmProvider } from "../.gen/providers/helm/provider/index.js";
/**
 * Service class to initialize Kubernetes and Helm providers consistently.
 * This pattern allows for dynamic cluster targeting without local kubeconfig files.
 */
export class K8sProviderService {
    /**
     * Initializes Kubernetes and Helm providers on the given scope.
     * By creating them without an alias, they become the "default" providers
     * for all resources within this stack.
     */
    static initialize(scope, config) {
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
    static fromEnv(scope) {
        this.initialize(scope, {
            kubeconfigPath: process.env.KUBECONFIG,
            kubeconfigContext: process.env.KUBECONFIG_CONTEXT,
            host: process.env.K8S_HOST,
            token: process.env.K8S_TOKEN,
            clusterCaCertificate: process.env.K8S_CA_CERT,
        });
    }
}
