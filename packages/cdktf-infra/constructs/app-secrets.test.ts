import { Testing } from "cdktf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesAgentApp } from "./hermes-agent.js";
import { OpenWebUiApp } from "./open-webui.js";
import { TabbyApiApp } from "./tabbyapi.js";
import { VllmApp } from "./vllm.js";

type Resources = Record<string, Record<string, { metadata?: { name?: string }; data?: Record<string, string> }>>;

const synth = (build: (scope: never) => unknown): Resources =>
  (JSON.parse(Testing.synthScope((scope) => { build(scope as never); })) as { resource: Resources }).resource;

const cases = [
  { app: "vLLM", secret: "hf-token-secret", keys: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"], value: "hf_vllm_token_never_in_a_spec", build: (scope: never) => new VllmApp(scope, "app", { image: "vllm/vllm-openai:v0.7.2", gpuCount: 1, gpuVendor: "nvidia", hfToken: "hf_vllm_token_never_in_a_spec" }) },
  { app: "TabbyAPI", secret: "hf-token-secret", keys: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"], value: "hf_tabby_token_never_in_a_spec", build: (scope: never) => new TabbyApiApp(scope, "app", { image: "ghcr.io/theroyallab/tabbyapi:latest", hfToken: "hf_tabby_token_never_in_a_spec", modelSizeBytes: 20e9, gpuCount: 1 }) },
  { app: "Open WebUI", secret: "open-webui-secrets", keys: ["OPENAI_API_KEY"], value: "sk-webui-never-in-a-spec", build: (scope: never) => new OpenWebUiApp(scope, "app", { openaiApiKey: "sk-webui-never-in-a-spec" }) },
  { app: "Hermes", secret: "hermes-secrets", keys: ["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", "OPENAI_API_KEY"], value: "dashboard-password-never-in-a-spec", build: (scope: never) => new HermesAgentApp(scope, "app", { dashboardAuthPassword: "dashboard-password-never-in-a-spec" }) },
];

beforeEach(() => { vi.stubEnv("APP_SERVICE_TYPE", "NodePort"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("an app's secrets", () => {
  for (const { app, secret, keys, value, build } of cases) {
    it(`${app} reads its secrets from a Secret, never as plain values in its Deployment`, () => {
      const resources = synth(build);
      const deployments = JSON.stringify(resources.kubernetes_deployment ?? resources.kubernetes_deployment_v1);
      expect(deployments).not.toContain(value);
      for (const key of keys) expect(deployments).toContain(`"name":"${key}","value_from":{"secret_key_ref":{"key":"${key}"`);
      const stored = Object.values(resources.kubernetes_secret ?? {}).find((entry) => entry.metadata?.name === secret);
      expect(stored?.data?.[keys[0]!]).toBe(value);
    });
  }

  for (const [app, build] of [["vLLM", (scope: never) => new VllmApp(scope, "app", { image: "vllm/vllm-openai:v0.7.2", gpuCount: 1, gpuVendor: "nvidia" })], ["TabbyAPI", (scope: never) => new TabbyApiApp(scope, "app", { image: "ghcr.io/theroyallab/tabbyapi:latest", modelSizeBytes: 20e9, gpuCount: 1 })]] as const) {
    it(`${app} takes its Hugging Face token only from what it is given, never from the environment`, () => {
      for (const name of ["HF_TOKEN", "VLLM_HF_TOKEN", "TABBYAPI_HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]) vi.stubEnv(name, "hf_from_the_environment");
      const resources = synth(build);
      expect(JSON.stringify(resources)).not.toContain("hf_from_the_environment");
      const stored = Object.values(resources.kubernetes_secret ?? {}).find((entry) => entry.metadata?.name === "hf-token-secret");
      expect(stored).toBeUndefined();
    });
  }

  it("Hermes never deploys with a default dashboard password", () => {
    expect(() => synth((scope) => new HermesAgentApp(scope, "app", {}))).toThrow(/Hermes needs a dashboard password/);
  });
});
