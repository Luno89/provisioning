import path from "node:path";
import { LocalBackend, TerraformStack, type App } from "cdktf";

export const statePath = (dir: string, stackId: string): string => path.join(dir, `terraform.${stackId}.tfstate`);

export function keepStateIn(app: App, dir: string | undefined): void {
  if (!dir) return;
  for (const child of app.node.children) {
    if (child instanceof TerraformStack) new LocalBackend(child, { path: statePath(dir, child.node.id) });
  }
}
