import { Construct } from "constructs";
import { dependable, type ITerraformDependable } from "cdktf";
import { Manifest } from "../.gen/providers/kubernetes/manifest/index.js";
import { manifestImportId, objectKey, type KubeObject } from "../lib/platform-objects.js";

export class PlatformManifests extends Construct {
  readonly namespaces: Manifest[] = [];
  private readonly made = new Map<string, Manifest>();

  constructor(scope: Construct, id: string, objects: readonly KubeObject[], existing: ReadonlySet<string>) {
    super(scope, id);
    const first = objects.filter((object) => object.kind === "Namespace");
    for (const [index, object] of [...first, ...objects.filter((object) => object.kind !== "Namespace")].entries()) {
      const manifest = new Manifest(this, `${object.kind.toLowerCase()}-${object.metadata.name}-${index}`, {
        manifest: object,
        fieldManager: { forceConflicts: true },
        ...(object.kind === "Namespace" ? {} : { dependsOn: [...this.namespaces] }),
      });
      if (existing.has(objectKey(object))) manifest.importFrom(manifestImportId(object));
      if (object.kind === "Namespace") this.namespaces.push(manifest);
      this.made.set(`${object.kind}/${object.metadata.name}`, manifest);
    }
  }

  dependOn(kind: string, name: string, on: ITerraformDependable): void {
    const manifest = this.made.get(`${kind}/${name}`);
    if (!manifest) throw new Error(`the manifests hold no ${kind} named ${name}`);
    manifest.dependsOn = [...(manifest.dependsOn ?? []), dependable(on)];
  }
}
