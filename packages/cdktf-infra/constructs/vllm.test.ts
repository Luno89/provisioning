import { Testing } from "cdktf";
import type { Construct } from "constructs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VllmApp, type VllmConfig } from "./vllm.js";

const serveOf = (config: Partial<VllmConfig>): string => {
  const build = (scope: Construct) => new VllmApp(scope, "app", { image: "vllm/vllm-openai:v0.32.0", gpuVendor: "nvidia", gpuCount: 1, ...config });
  const synthed = JSON.parse(Testing.synthScope((scope) => { build(scope); })) as { resource: { kubernetes_deployment: Record<string, { spec: { template: { spec: { container: { args?: string[] }[] } } } }> } };
  return Object.values(synthed.resource.kubernetes_deployment)[0]?.spec.template.spec.container[0]?.args?.[0] ?? "";
};

beforeEach(() => { vi.stubEnv("APP_SERVICE_TYPE", "NodePort"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("vLLM's tool calling", () => {
  it("serves tools with the parser it was given", () => {
    const serve = serveOf({ model: "Qwen/Qwen2.5-0.5B-Instruct", toolCallingEnabled: true, toolCallParser: "hermes" });
    expect(serve).toContain("--enable-auto-tool-choice");
    expect(serve).toContain("--tool-call-parser hermes");
  });

  it("is refused when tool calling is on and no parser was given, rather than served without tools", () => {
    expect(() => serveOf({ model: "someone/their-own-model", toolCallingEnabled: true })).toThrow("vLLM with tool calling on needs a tool call parser for someone/their-own-model: pick one, or turn tool calling off");
  });

  it("serves no tools when tool calling is off", () => {
    expect(serveOf({ toolCallingEnabled: false, toolCallParser: "hermes" })).not.toContain("--enable-auto-tool-choice");
  });
});
