import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RULES: Record<string, { off: Record<string, string>; never: readonly string[] }> = {
  Release: { off: { wait: "false", timeout: "HELM_CEILING_SECONDS" }, never: ["atomic", "waitForJobs"] },
  Deployment: { off: { waitForRollout: "false" }, never: ["timeouts"] },
  StatefulSet: { off: { waitForRollout: "false" }, never: ["timeouts"] },
  DaemonSet: { off: { waitForRollout: "false" }, never: ["timeouts"] },
  Daemonset: { off: { waitForRollout: "false" }, never: ["timeouts"] },
  Job: { off: { waitForCompletion: "false" }, never: ["timeouts"] },
  PersistentVolumeClaim: { off: { waitUntilBound: "false" }, never: ["timeouts"] },
};

const sources = (dir: string) => readdirSync(path.join(root, dir))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => path.join(dir, name));

export function terraformWaits(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const rule = RULES[node.expression.text];
      const config = node.arguments?.[2];
      if (rule && config && ts.isObjectLiteralExpression(config)) {
        const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.expression.text}`;
        const props = new Map(config.properties.filter(ts.isPropertyAssignment).map((prop) => [prop.name.getText(source), prop.initializer.getText(source)]));
        for (const [name, value] of Object.entries(rule.off)) if (props.get(name) !== value) found.push(`${where} does not set ${name}: ${value}`);
        for (const name of rule.never) if (props.has(name)) found.push(`${where} sets ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("Terraform never waits on what it makes", () => {
  it("finds a release that waits, one with a time limit, and passes one that does neither", () => {
    expect(terraformWaits("x.ts", 'new Release(this, "a", { name: "a", timeout: 600 });')).toEqual(["x.ts:1 Release does not set wait: false", "x.ts:1 Release does not set timeout: HELM_CEILING_SECONDS"]);
    expect(terraformWaits("x.ts", 'new Release(this, "a", { wait: false, timeout: HELM_CEILING_SECONDS, atomic: true });')).toEqual(["x.ts:1 Release sets atomic"]);
    expect(terraformWaits("x.ts", 'new Deployment(this, "d", { waitForRollout: false, spec: {} });')).toEqual([]);
  });

  it("every Helm release, workload, job and claim a construct makes is left to Koala to watch", () => {
    const found = [...sources("constructs"), ...sources("lib"), "main.ts"]
      .flatMap((file) => terraformWaits(file, readFileSync(path.join(root, file), "utf8")));
    expect(found).toEqual([]);
  });
});
