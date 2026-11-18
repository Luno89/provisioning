import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App, TerraformStack, Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { keepState } from "./state.js";

const TERRAFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/terraform");

const init = (cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; said: string }> => new Promise((resolve) => {
  execFile(TERRAFORM, ["init", "-input=false", "-no-color"], { cwd, env }, (error, stdout, stderr) => {
    resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, said: `${stdout}${stderr}` });
  });
});

describe("the kubernetes backend a stack is given, read by real Terraform", () => {
  it("is a configuration Terraform takes, which then reaches for the pod's own account and nothing else", async () => {
    const app = Testing.app() as App;
    const stack = new TerraformStack(app, "app-machine-desk-40213377");
    keepState(app, { CDKTF_STATE_NAMESPACE: "koala" });
    const work = await mkdtemp(path.join(tmpdir(), "kubernetes-backend-"));
    try {
      await writeFile(path.join(work, "cdk.tf.json"), Testing.synth(stack));
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, KUBERNETES_SERVICE_HOST: "127.0.0.1", KUBERNETES_SERVICE_PORT: "9", TF_IN_AUTOMATION: "true" };
      const { code, said } = await init(work, env);
      expect(code).not.toBe(0);
      expect(said).toContain("Initializing the backend");
      expect(said).toMatch(/serviceaccount\/token|127\.0\.0\.1:9/);
      expect(said).not.toMatch(/Unsupported argument|Invalid backend|secret_suffix/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
