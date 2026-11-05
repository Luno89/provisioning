import { describe, expect, it } from "vitest";
import { providerConfigFrom } from "./k8s-provider-service.js";

const inCluster = { K8S_HOST: "https://kubernetes.default.svc", K8S_TOKEN: "sa-token", K8S_CA_CERT: "ca" };

describe("which cluster an app's stack reaches", () => {
  it("is the cluster its kubeconfig names, never the worker's own, when the app is for another cluster", () => {
    expect(providerConfigFrom({ ...inCluster, CLUSTER_NAME: "mesh-desk", KUBECONFIG: "/tmp/handed-kubeconfig-machine-desk" })).toEqual({
      kubeconfigPath: "/tmp/handed-kubeconfig-machine-desk",
      kubeconfigContext: undefined,
    });
  });

  it("is the worker's own cluster through its service account when the app is for the system cluster", () => {
    expect(providerConfigFrom({ ...inCluster, CLUSTER_NAME: "provisioning-lunorica", KUBECONFIG: "/app/.kube/config" })).toEqual({
      kubeconfigPath: "/app/.kube/config", kubeconfigContext: undefined, host: inCluster.K8S_HOST, token: "sa-token", clusterCaCertificate: "ca",
    });
  });
});
