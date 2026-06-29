import { Construct } from "constructs";
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
export declare class K8sProviderService {
    /**
     * Initializes Kubernetes and Helm providers on the given scope.
     * By creating them without an alias, they become the "default" providers
     * for all resources within this stack.
     */
    static initialize(scope: Construct, config: K8sProviderConfig): void;
    /**
     * Factory method to initialize providers from environment variables.
     */
    static fromEnv(scope: Construct): void;
}
//# sourceMappingURL=k8s-provider-service.d.ts.map