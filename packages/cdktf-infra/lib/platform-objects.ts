import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  [field: string]: unknown;
}

export const objectKey = (object: Pick<KubeObject, "apiVersion" | "kind" | "metadata">): string =>
  `${object.apiVersion}/${object.kind}/${object.metadata.namespace ?? ""}/${object.metadata.name}`;

export const releaseKey = (namespace: string, name: string): string => `helm/${namespace}/${name}`;

export const manifestImportId = (object: KubeObject): string =>
  [`apiVersion=${object.apiVersion}`, `kind=${object.kind}`, ...(object.metadata.namespace ? [`namespace=${object.metadata.namespace}`] : []), `name=${object.metadata.name}`].join(",");

const BINARY = ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"];

export function canonicalQuantity(quantity: string): string {
  const milli = /^(\d+)m$/.exec(quantity);
  if (milli) return Number(milli[1]) % 1000 === 0 ? String(Number(milli[1]) / 1000) : quantity;
  const binary = /^(\d+)(Ki|Mi|Gi|Ti|Pi)$/.exec(quantity);
  if (!binary) return quantity;
  let [amount, at] = [Number(binary[1]), BINARY.indexOf(binary[2]!)];
  while (amount >= 1024 && amount % 1024 === 0 && at < BINARY.length - 1) [amount, at] = [amount / 1024, at + 1];
  return `${amount}${BINARY[at]}`;
}

const QUANTITIES = new Set(["limits", "requests"]);

function canonical(value: unknown, within: string | undefined): unknown {
  if (typeof value === "string") return within !== undefined && (QUANTITIES.has(within) || within === "sizeLimit") ? canonicalQuantity(value) : value;
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, undefined));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, canonical(entry, QUANTITIES.has(within ?? "") ? within : key)]));
}

export function objectsIn(file: string): KubeObject[] {
  const objects: KubeObject[] = [];
  for (const document of parseAllDocuments(readFileSync(file, "utf8"))) {
    const [problem] = document.errors;
    if (problem) throw new Error(`${file} is not YAML Koala can read: ${problem.message}`);
    const object = canonical(document.toJSON(), undefined) as KubeObject | null;
    if (object !== null) objects.push(object);
  }
  return objects;
}

export function withPodAnnotations(objects: readonly KubeObject[], deployment: string, annotations: Record<string, string>): KubeObject[] {
  const found = objects.filter((object) => object.kind === "Deployment" && object.metadata.name === deployment);
  if (found.length !== 1) throw new Error(`the manifests hold ${found.length} Deployments named ${deployment}, and its pods are annotated on exactly one`);
  return objects.map((object) => {
    if (object !== found[0]) return object;
    const spec = object.spec as { template: { metadata?: { annotations?: Record<string, string> } } };
    return { ...object, spec: { ...spec, template: { ...spec.template, metadata: { ...spec.template.metadata, annotations: { ...spec.template.metadata?.annotations, ...annotations } } } } };
  });
}

export const answeringOnly = (namespace: string, koalaNamespace: string): KubeObject => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: "koala-only", namespace },
  spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": koalaNamespace } } }] }] },
});
