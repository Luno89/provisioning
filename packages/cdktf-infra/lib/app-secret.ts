import { Construct } from "constructs";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";

export interface SecretEnvEntry {
  name: string;
  valueFrom: { secretKeyRef: { name: string; key: string } };
}

export function secretEnv(scope: Construct, namespace: string, name: string, values: Readonly<Record<string, string | undefined>>): SecretEnvEntry[] {
  const present = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (present.length === 0) return [];
  const secret = new Secret(scope, name, { metadata: { name, namespace }, data: Object.fromEntries(present) });
  return present.map(([key]) => ({ name: key, valueFrom: { secretKeyRef: { name: secret.metadata.name, key } } }));
}
