import { Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { HermesAgentApp } from "./hermes-agent.js";
import { OpenWebUiApp } from "./open-webui.js";
import { TabbyApiApp } from "./tabbyapi.js";
import { VllmApp } from "./vllm.js";

type Resources = Record<string, Record<string, { metadata?: { name?: string }; data?: Record<string, string> }>>;

const synth = (build: (scope: never) => unknown): Resources =>
  (JSON.parse(Testing.synthScope((scope) => { build(scope as never); })) as { resource: Resources }).resource;

const cases = [
  { app: "vLLM", secret: "hf-token-secret", keys: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"], value: "hf_vllm_token_never_in_a_spec", build: (scope: never) => new VllmApp(scope, "app", { hfToken: "hf_vllm_token_never_in_a_spec" }) },
  { app: "TabbyAPI", secret: "hf-token-secret", keys: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"], value: "hf_tabby_token_never_in_a_spec", build: (scope: never) => new TabbyApiApp(scope, "app", { hfToken: "hf_tabby_token_never_in_a_spec" }) },
  { app: "Open WebUI", secret: "open-webui-secrets", keys: ["OPENAI_API_KEY"], value: "sk-webui-never-in-a-spec", build: (scope: never) => new OpenWebUiApp(scope, "app", { openaiApiKey: "sk-webui-never-in-a-spec" }) },
  { app: "Hermes", secret: "hermes-secrets", keys: ["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", "OPENAI_API_KEY"], value: "dashboard-password-never-in-a-spec", build: (scope: never) => new HermesAgentApp(scope, "app", { dashboardAuthPassword: "dashboard-password-never-in-a-spec" }) },
];

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
});
