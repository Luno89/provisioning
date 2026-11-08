import { Construct } from "constructs";
import { KubernetesProvider } from "../.gen/providers/kubernetes/provider/index.js";
import { HelmProvider } from "../.gen/providers/helm/provider/index.js";

export interface K8sProviderConfig {
  readonly kubeconfigPath: string;
}

export function kubeconfigFrom(env: NodeJS.ProcessEnv, name: "KUBECONFIG" | "KUBECONFIG_PATH"): string {
  const path = env[name]?.trim();
  if (!path) throw new Error(`a stack reaches its cluster through the kubeconfig in ${name}, which is not set`);
  return path;
}

export class K8sProviderService {
  static initialize(scope: Construct, config: K8sProviderConfig) {
    new KubernetesProvider(scope, "kubernetes", { configPath: config.kubeconfigPath });
    new HelmProvider(scope, "helm", { kubernetes: { configPath: config.kubeconfigPath } });
  }

  static fromEnv(scope: Construct): void {
    this.initialize(scope, { kubeconfigPath: kubeconfigFrom(process.env, "KUBECONFIG") });
  }
}
