import { App, TerraformStack, Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { keepState, stateSecretSuffix, statePath } from "./state.js";

const backendOf = (stack: TerraformStack): unknown => (JSON.parse(Testing.synth(stack)) as { terraform?: { backend?: unknown } }).terraform?.backend;

describe("where a stack keeps its Terraform state", () => {
  it("names each stack's state file in the folder given", () => {
    expect(statePath("/data/terraform", "app-desk-1234")).toBe("/data/terraform/terraform.app-desk-1234.tfstate");
  });

  it("puts every stack's state in that folder, one file per stack", () => {
    const app = Testing.app() as App;
    const one = new TerraformStack(app, "machine-desk");
    const two = new TerraformStack(app, "machine-desk-observability");
    keepState(app, { CDKTF_STATE_DIR: "/data/terraform" });
    expect(backendOf(one)).toEqual({ local: { path: "/data/terraform/terraform.machine-desk.tfstate" } });
    expect(backendOf(two)).toEqual({ local: { path: "/data/terraform/terraform.machine-desk-observability.tfstate" } });
  });

  it("keeps each stack's state in a Secret of its own in the namespace given, read with the pod's own account", () => {
    const app = Testing.app() as App;
    const one = new TerraformStack(app, "machine-desk");
    const two = new TerraformStack(app, "app-machine-ab12-12345678");
    keepState(app, { CDKTF_STATE_DIR: "/data/terraform", CDKTF_STATE_NAMESPACE: "koala" });
    expect(backendOf(one)).toEqual({ kubernetes: { secret_suffix: "machine-desk-state", namespace: "koala", in_cluster_config: true } });
    expect(backendOf(two)).toEqual({ kubernetes: { secret_suffix: "app-machine-ab12-12345678-state", namespace: "koala", in_cluster_config: true } });
  });

  it("leaves Terraform's own default when neither is given", () => {
    const app = Testing.app() as App;
    const stack = new TerraformStack(app, "plain");
    keepState(app, {});
    expect(backendOf(stack)).toBeUndefined();
  });
});

describe("the suffix a stack's state Secret is named with", () => {
  const label = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

  it("is the stack's own name with -state, so it never ends in a number Terraform would take for a chunk of the state", () => {
    expect(stateSecretSuffix("app-machine-desk-40213377")).toBe("app-machine-desk-40213377-state");
  });

  it("fits a label and a Secret's name however long or odd the stack's name, and two names never share one", () => {
    const long = `machine-${"f".repeat(36)}-observability`;
    for (const name of [long, "App_Desk.1", "app_desk.1", "-x-"]) {
      const suffix = stateSecretSuffix(name);
      expect(suffix.length, name).toBeLessThanOrEqual(63);
      expect(suffix, name).toMatch(label);
      expect(suffix, name).toMatch(/-state$/);
    }
    expect(stateSecretSuffix("App_Desk.1")).not.toBe(stateSecretSuffix("app_desk.1"));
    expect(stateSecretSuffix(long)).toBe(stateSecretSuffix(long));
    expect(stateSecretSuffix(long)).not.toBe(stateSecretSuffix(`${long}x`));
  });
});
