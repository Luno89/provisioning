import { Testing } from "cdktf";
import type { Construct } from "constructs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabbyApiApp } from "./tabbyapi.js";
import { VllmApp } from "./vllm.js";

interface Pod {
  host_ipc?: boolean;
  host_network?: boolean;
  runtime_class_name?: string;
  container: { resources: { limits: Record<string, string> }; security_context?: { run_as_group?: string }; liveness_probe?: { tcp_socket?: { port: string }[] } }[];
}

const podOf = (build: (scope: Construct) => unknown): Pod => {
  const synthed = JSON.parse(Testing.synthScope((scope) => { build(scope); })) as { resource: { kubernetes_deployment: Record<string, { spec: { template: { spec: Pod } } }> } };
  const deployment = Object.values(synthed.resource.kubernetes_deployment)[0];
  if (!deployment) throw new Error("no deployment was synthesized");
  return deployment.spec.template.spec;
};

beforeEach(() => { vi.stubEnv("APP_SERVICE_TYPE", "NodePort"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("TabbyAPI's memory", () => {
  it("is refused when neither the model's size nor the memory to give it is known", () => {
    expect(() => podOf((scope) => new TabbyApiApp(scope, "app", { image: "ghcr.io/theroyallab/tabbyapi:latest", gpuCount: 1 }))).toThrow("TabbyAPI's memory cannot be sized: neither the model's size nor a memory limit and shared memory were given");
  });

  it("is sized from the model, or taken as given", () => {
    const sized = podOf((scope) => new TabbyApiApp(scope, "app", { image: "ghcr.io/theroyallab/tabbyapi:latest", gpuCount: 1, modelSizeBytes: 20e9, maxSeqLen: 4096 }));
    expect(sized.container[0]?.resources.limits.memory).toBe("35G");
    const given = podOf((scope) => new TabbyApiApp(scope, "app", { image: "ghcr.io/theroyallab/tabbyapi:latest", gpuCount: 1, memoryLimit: "48G", shmSize: "16Gi" }));
    expect(given.container[0]?.resources.limits.memory).toBe("48G");
  });
});

describe("a GPU model server's pod", () => {
  it("shares the host's network and IPC on AMD, as ROCm needs, and may trace", () => {
    const pod = podOf((scope) => new VllmApp(scope, "app", { image: "vllm/vllm-openai-rocm:v0.7.2", gpuVendor: "amd", gpuCount: 1 }));
    expect(pod.host_network).toBe(true);
    expect(pod.host_ipc).toBe(true);
    expect(pod.runtime_class_name).toBeUndefined();
    expect(pod.container[0]?.security_context?.run_as_group).toBe("44");
    expect(pod.container[0]?.resources.limits["amd.com/gpu"]).toBe("1");
  });

  it("runs under the nvidia runtime class on NVIDIA and keeps its own network", () => {
    const pod = podOf((scope) => new VllmApp(scope, "app", { image: "vllm/vllm-openai:v0.7.2", gpuVendor: "nvidia", gpuCount: 2 }));
    expect(pod.runtime_class_name).toBe("nvidia");
    expect(pod.host_network).toBeUndefined();
    expect(pod.container[0]?.resources.limits["nvidia.com/gpu"]).toBe("2");
  });

  it("checks TabbyAPI is alive only by its port accepting connections", () => {
    const pod = podOf((scope) => new TabbyApiApp(scope, "app", { image: "ghcr.io/theroyallab/tabbyapi:latest", gpuCount: 1, modelSizeBytes: 20e9 }));
    expect(pod.runtime_class_name).toBe("nvidia");
    expect(pod.container[0]?.liveness_probe?.tcp_socket).toEqual([{ port: "5000" }]);
  });
});
