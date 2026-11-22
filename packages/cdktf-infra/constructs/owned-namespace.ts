import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { objectKey } from "../lib/platform-objects.js";

export function ownedNamespace(scope: Construct, id: string, name: string, existing: ReadonlySet<string>): Namespace {
  const made = new Namespace(scope, id, { metadata: { name } });
  if (existing.has(objectKey({ apiVersion: "v1", kind: "Namespace", metadata: { name } }))) made.importFrom(name);
  return made;
}

export class InMonitoringNamespace extends Construct {
  protected readonly namespace: Namespace;

  constructor(scope: Construct, id: string, existing: ReadonlySet<string>) {
    super(scope, id);
    this.namespace = ownedNamespace(this, "monitoring-ns", "monitoring", existing);
  }
}
