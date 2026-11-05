import { App, TerraformStack, Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { keepStateIn, statePath } from "./state.js";

const backendOf = (stack: TerraformStack): unknown => (JSON.parse(Testing.synth(stack)) as { terraform?: { backend?: unknown } }).terraform?.backend;

describe("where a stack keeps its Terraform state", () => {
  it("names each stack's state file in the folder given", () => {
    expect(statePath("/data/terraform", "app-desk-1234")).toBe("/data/terraform/terraform.app-desk-1234.tfstate");
  });

  it("puts every stack's state in that folder, one file per stack", () => {
    const app = Testing.app() as App;
    const one = new TerraformStack(app, "provisioning-lunorica");
    const two = new TerraformStack(app, "provisioning-lunorica-observability");
    keepStateIn(app, "/data/terraform");
    expect(backendOf(one)).toEqual({ local: { path: "/data/terraform/terraform.provisioning-lunorica.tfstate" } });
    expect(backendOf(two)).toEqual({ local: { path: "/data/terraform/terraform.provisioning-lunorica-observability.tfstate" } });
  });

  it("leaves Terraform's own default when no folder is given", () => {
    const app = Testing.app() as App;
    const stack = new TerraformStack(app, "plain");
    keepStateIn(app, undefined);
    expect(backendOf(stack)).toBeUndefined();
  });
});
