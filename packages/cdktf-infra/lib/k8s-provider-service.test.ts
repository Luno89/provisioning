import { describe, expect, it } from "vitest";
import { kubeconfigFrom } from "./k8s-provider-service.js";

describe("which cluster a stack reaches", () => {
  it("is the cluster the kubeconfig it was handed names, whatever cluster the worker runs in", () => {
    expect(kubeconfigFrom({ CLUSTER_NAME: "provisioning-lunorica", KUBECONFIG: "/tmp/koala-clusters-1/kubeconfig-koala", K8S_HOST: "https://kubernetes.default.svc", K8S_TOKEN: "sa-token" }, "KUBECONFIG")).toBe("/tmp/koala-clusters-1/kubeconfig-koala");
    expect(kubeconfigFrom({ KUBECONFIG_PATH: "/tmp/koala-clusters-1/kubeconfig-machine-desk" }, "KUBECONFIG_PATH")).toBe("/tmp/koala-clusters-1/kubeconfig-machine-desk");
  });

  it("is refused, saying which setting is missing, when no kubeconfig was handed", () => {
    expect(() => kubeconfigFrom({ CLUSTER_NAME: "mesh-desk", K8S_HOST: "https://kubernetes.default.svc" }, "KUBECONFIG")).toThrow("a stack reaches its cluster through the kubeconfig in KUBECONFIG, which is not set");
    expect(() => kubeconfigFrom({ KUBECONFIG_PATH: "  " }, "KUBECONFIG_PATH")).toThrow("KUBECONFIG_PATH, which is not set");
  });
});
