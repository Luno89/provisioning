import type { DeploymentConfig, DeploymentSpecTemplateSpecVolume, DeploymentSpecTemplateSpecContainerVolumeMount } from "../.gen/providers/kubernetes/deployment/index.js";
import type { ServiceConfig } from "../.gen/providers/kubernetes/service/index.js";
import type { PersistentVolumeClaimSpec } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

function fieldsAt(value: unknown, where: string): Fields {
  if (!isFields(value)) throw new Error(`${where} is not an object`);
  return value;
}

function textAt(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} is not text`);
  return value;
}

function listAt(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not a list`);
  return value;
}

export function jsonFrom(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`${name} is not valid JSON: ${(err as Error).message}`);
  }
}

export function settingsFrom(name: string, value: unknown): Record<string, string> {
  const settings = fieldsAt(value, name);
  for (const [key, setting] of Object.entries(settings)) textAt(setting, `${name}.${key}`);
  return settings as Record<string, string>;
}

export interface Bindings {
  volumes: DeploymentSpecTemplateSpecVolume[];
  volumeMounts: DeploymentSpecTemplateSpecContainerVolumeMount[];
  env: { name: string; value: string }[];
}

export function bindingsFrom(value: unknown): Bindings {
  const bindings = fieldsAt(value, "BINDINGS_JSON");
  const volumes = listAt(bindings.volumes, "BINDINGS_JSON.volumes").map((volume, i) => {
    const where = `BINDINGS_JSON.volumes[${i}]`;
    const fields = fieldsAt(volume, where);
    return { name: textAt(fields.name, `${where}.name`), secret: { secretName: textAt(fieldsAt(fields.secret, `${where}.secret`).secretName, `${where}.secret.secretName`) } };
  });
  const volumeMounts = listAt(bindings.volumeMounts, "BINDINGS_JSON.volumeMounts").map((mount, i) => {
    const where = `BINDINGS_JSON.volumeMounts[${i}]`;
    const fields = fieldsAt(mount, where);
    return { name: textAt(fields.name, `${where}.name`), mountPath: textAt(fields.mountPath, `${where}.mountPath`), readOnly: fields.readOnly === true };
  });
  const env = listAt(bindings.env, "BINDINGS_JSON.env").map((entry, i) => {
    const where = `BINDINGS_JSON.env[${i}]`;
    const fields = fieldsAt(entry, where);
    return { name: textAt(fields.name, `${where}.name`), value: textAt(fields.value, `${where}.value`) };
  });
  return { volumes, volumeMounts, env };
}

export interface RenderedAppConfig {
  namespace: { metadata: { name: string } };
  secret?: { metadata: { name: string; namespace: string }; data: Record<string, string>; type: string };
  configMap?: { metadata: { name: string; namespace: string }; data: Record<string, string> };
  pvcs: { metadata: { name: string; namespace: string }; spec: PersistentVolumeClaimSpec; waitUntilBound: boolean }[];
  deployment: DeploymentConfig;
  service: ServiceConfig & { metadata: { name: string } };
  ingressPort?: number;
  health?: { port: number; path: string };
}

function holdsRenderedApp(value: unknown): value is RenderedAppConfig {
  const rendered = fieldsAt(value, "APP_SPEC_JSON");
  textAt(fieldsAt(fieldsAt(rendered.namespace, "APP_SPEC_JSON.namespace").metadata, "APP_SPEC_JSON.namespace.metadata").name, "APP_SPEC_JSON.namespace.metadata.name");
  listAt(rendered.pvcs, "APP_SPEC_JSON.pvcs").forEach((pvc, i) => {
    const fields = fieldsAt(pvc, `APP_SPEC_JSON.pvcs[${i}]`);
    textAt(fieldsAt(fields.metadata, `APP_SPEC_JSON.pvcs[${i}].metadata`).name, `APP_SPEC_JSON.pvcs[${i}].metadata.name`);
    fieldsAt(fields.spec, `APP_SPEC_JSON.pvcs[${i}].spec`);
  });
  const deployment = fieldsAt(rendered.deployment, "APP_SPEC_JSON.deployment");
  fieldsAt(deployment.metadata, "APP_SPEC_JSON.deployment.metadata");
  fieldsAt(fieldsAt(fieldsAt(deployment.spec, "APP_SPEC_JSON.deployment.spec").template, "APP_SPEC_JSON.deployment.spec.template").spec, "APP_SPEC_JSON.deployment.spec.template.spec");
  const service = fieldsAt(rendered.service, "APP_SPEC_JSON.service");
  textAt(fieldsAt(service.metadata, "APP_SPEC_JSON.service.metadata").name, "APP_SPEC_JSON.service.metadata.name");
  if (rendered.secret !== undefined) fieldsAt(fieldsAt(rendered.secret, "APP_SPEC_JSON.secret").data, "APP_SPEC_JSON.secret.data");
  if (rendered.configMap !== undefined) fieldsAt(fieldsAt(rendered.configMap, "APP_SPEC_JSON.configMap").data, "APP_SPEC_JSON.configMap.data");
  if (rendered.ingressPort !== undefined && typeof rendered.ingressPort !== "number") throw new Error("APP_SPEC_JSON.ingressPort is not a number");
  if (rendered.health !== undefined) {
    const health = fieldsAt(rendered.health, "APP_SPEC_JSON.health");
    if (typeof health.port !== "number") throw new Error("APP_SPEC_JSON.health.port is not a number");
    textAt(health.path, "APP_SPEC_JSON.health.path");
  }
  return true;
}

export function renderedAppFrom(value: unknown): RenderedAppConfig {
  if (holdsRenderedApp(value)) return value;
  throw new Error("APP_SPEC_JSON is not a rendered app");
}
