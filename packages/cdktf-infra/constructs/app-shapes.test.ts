import { Testing } from "cdktf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordPressNativeApp } from "./wordpress-native.js";
import { NextcloudNativeApp } from "./nextcloud-native.js";
import { PrometheusApp } from "./prometheus.js";
import { TraefikApp } from "./traefik.js";

interface Env { name: string; value?: string; value_from?: { secret_key_ref?: { name: string; key: string } } }
interface Container { name: string; image: string; env?: Env[]; volume_mount?: { name: string; mount_path: string }[] }
interface Deployment { metadata: { name: string; namespace: string }; spec: { template: { spec: { container: Container[]; volume?: { name: string; persistent_volume_claim?: { claim_name: string } }[] } } } }
interface Service { metadata: { name: string }; spec: { type?: string; port: { port: number }[] } }
interface Claim { metadata: { name: string }; spec: { resources: { requests: { storage: string } } } }
interface Release { name: string; chart: string; version?: string; namespace: string; set?: { name: string; value: string }[]; values?: string[] }
interface Resources {
  kubernetes_namespace?: Record<string, { metadata: { name: string } }>;
  kubernetes_deployment?: Record<string, Deployment>;
  kubernetes_service?: Record<string, Service>;
  kubernetes_persistent_volume_claim?: Record<string, Claim>;
  kubernetes_secret?: Record<string, { metadata: { name: string }; data: Record<string, string> }>;
  helm_release?: Record<string, Release>;
}

const synth = (build: (scope: never) => unknown): Resources =>
  (JSON.parse(Testing.synthScope((scope) => { build(scope as never); })) as { resource: Resources }).resource;

const named = <T extends { metadata: { name: string } }>(records: Record<string, T> | undefined, name: string): T | undefined =>
  Object.values(records ?? {}).find((record) => record.metadata.name === name);

const nameBehind = (resources: Resources, kind: "kubernetes_secret" | "kubernetes_persistent_volume_claim", token: string | undefined): string | undefined => {
  const id = token?.match(new RegExp(`^\\$\\{${kind}\\.([^.]+)\\.metadata\\[0\\]\\.name\\}$`))?.[1];
  return id === undefined ? token : resources[kind]?.[id]?.metadata.name;
};

const secretRefs = (resources: Resources, deployment: Deployment | undefined): Record<string, string> =>
  Object.fromEntries((deployment?.spec.template.spec.container ?? []).flatMap((c) => c.env ?? [])
    .filter((env) => env.value_from?.secret_key_ref).map((env) => [env.name, `${nameBehind(resources, "kubernetes_secret", env.value_from!.secret_key_ref!.name)}/${env.value_from!.secret_key_ref!.key}`]));

const plainPasswords = (resources: Resources): string[] =>
  Object.values(resources.kubernetes_deployment ?? {}).flatMap((d) => d.spec.template.spec.container.flatMap((c) => c.env ?? []))
    .filter((env) => /PASSWORD|SECRET|TOKEN/.test(env.name) && env.value !== undefined).map((env) => env.name);

beforeEach(() => { vi.stubEnv("APP_SERVICE_TYPE", "NodePort"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("WordPress", () => {
  const resources = () => synth((scope) => new WordPressNativeApp(scope, "app", { namespace: "blog", webTag: "6.8-apache", dbStorage: "5Gi" }));

  it("deploys its site and its database in the app's namespace, on the images asked for", () => {
    const r = resources();
    expect(named(r.kubernetes_namespace, "blog")).toBeDefined();
    expect(named(r.kubernetes_deployment, "wordpress")?.spec.template.spec.container[0]?.image).toBe("library/wordpress:6.8-apache");
    expect(named(r.kubernetes_deployment, "wordpress-db")?.spec.template.spec.container[0]?.image).toBe("library/mariadb:11.4");
  });

  it("is reached through a Service of the type it is told, and keeps its database on a volume of the size asked", () => {
    const r = resources();
    expect(named(r.kubernetes_service, "wordpress")?.spec).toMatchObject({ type: "NodePort", port: [{ port: 80 }] });
    expect(named(r.kubernetes_persistent_volume_claim, "wordpress-db-pvc")?.spec.resources.requests.storage).toBe("5Gi");
    const db = named(r.kubernetes_deployment, "wordpress-db")?.spec.template.spec;
    expect(nameBehind(r, "kubernetes_persistent_volume_claim", db?.volume?.[0]?.persistent_volume_claim?.claim_name)).toBe("wordpress-db-pvc");
    expect(db?.container[0]?.volume_mount?.[0]?.mount_path).toBe("/var/lib/mysql");
  });

  it("reads its database passwords from a Secret, never as plain values in its Deployments", () => {
    const r = resources();
    expect(plainPasswords(r)).toEqual([]);
    expect(secretRefs(r, named(r.kubernetes_deployment, "wordpress"))).toEqual({ WORDPRESS_DB_PASSWORD: "wordpress-db-credentials/mysql-password" });
    expect(secretRefs(r, named(r.kubernetes_deployment, "wordpress-db"))).toEqual({ MYSQL_PASSWORD: "wordpress-db-credentials/mysql-password", MYSQL_ROOT_PASSWORD: "wordpress-db-credentials/mysql-root-password" });
    expect(Object.keys(named(r.kubernetes_secret, "wordpress-db-credentials")?.data ?? {}).sort()).toEqual(["mysql-password", "mysql-root-password"]);
  });
});

describe("Nextcloud", () => {
  const resources = () => synth((scope) => new NextcloudNativeApp(scope, "app", { namespace: "cloud", adminPassword: "admin-password-never-in-a-spec", webStorage: "20Gi", dbStorage: "3Gi" }));

  it("deploys its site and its database in the app's namespace", () => {
    const r = resources();
    expect(named(r.kubernetes_namespace, "cloud")).toBeDefined();
    expect(named(r.kubernetes_deployment, "nextcloud")).toBeDefined();
    expect(named(r.kubernetes_deployment, "nextcloud-db")).toBeDefined();
  });

  it("is reached through a Service of the type it is told, and keeps its files and database on volumes of the sizes asked", () => {
    const r = resources();
    expect(named(r.kubernetes_service, "nextcloud")?.spec).toMatchObject({ type: "NodePort", port: [{ port: 80 }] });
    expect(named(r.kubernetes_persistent_volume_claim, "nextcloud-web-pvc")?.spec.resources.requests.storage).toBe("20Gi");
    expect(named(r.kubernetes_persistent_volume_claim, "nextcloud-db-pvc")?.spec.resources.requests.storage).toBe("3Gi");
  });

  it("reads its admin and database passwords from a Secret, never as plain values in its Deployments", () => {
    const r = resources();
    expect(plainPasswords(r)).toEqual([]);
    expect(JSON.stringify(r.kubernetes_deployment)).not.toContain("admin-password-never-in-a-spec");
    expect(secretRefs(r, named(r.kubernetes_deployment, "nextcloud"))).toMatchObject({ MYSQL_PASSWORD: "nextcloud-db-credentials/mysql-password", NEXTCLOUD_ADMIN_PASSWORD: "nextcloud-db-credentials/admin-password" });
    expect(named(r.kubernetes_secret, "nextcloud-db-credentials")?.data["admin-password"]).toBe("admin-password-never-in-a-spec");
  });

  it("makes a password of its own for each deploy when none is given", () => {
    const one = named(synth((scope) => new NextcloudNativeApp(scope, "app", {})).kubernetes_secret, "nextcloud-db-credentials")?.data;
    const two = named(synth((scope) => new NextcloudNativeApp(scope, "app", {})).kubernetes_secret, "nextcloud-db-credentials")?.data;
    expect(one?.["admin-password"]).toMatch(/^[0-9a-f]{48}$/);
    expect(one?.["admin-password"]).not.toBe(two?.["admin-password"]);
  });
});

describe("Prometheus", () => {
  const release = (config: ConstructorParameters<typeof PrometheusApp>[2]) => Object.values(synth((scope) => new PrometheusApp(scope, "app", config)).helm_release ?? {})[0];

  it("deploys the pinned kube-prometheus-stack in the app's namespace, its Service of the type it is told and its volume the size asked", () => {
    expect(named(synth((scope) => new PrometheusApp(scope, "app", { namespace: "metrics" })).kubernetes_namespace, "metrics")).toBeDefined();
    const r = release({ namespace: "metrics", serverStorage: "30Gi", webTag: "v3.5.0" });
    expect(r).toMatchObject({ name: "prometheus", chart: "kube-prometheus-stack", version: "91.7.0" });
    expect(r?.set).toEqual(expect.arrayContaining([
      { name: "prometheus.prometheusSpec.service.type", value: "NodePort" },
      { name: "prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage", value: "30Gi" },
      { name: "prometheus.prometheusSpec.image.tag", value: "v3.5.0" },
    ]));
  });

  it("holds no secret of its own in what it hands Helm", () => {
    expect(JSON.stringify(release({}))).not.toMatch(/password|token|secret/i);
  });
});

describe("Traefik", () => {
  const release = (config: ConstructorParameters<typeof TraefikApp>[2]) => Object.values(synth((scope) => new TraefikApp(scope, "app", config)).helm_release ?? {})[0];

  it("deploys the pinned Traefik chart, its Service of the type it is told, on ports apart from the cluster's own ingress", () => {
    expect(named(synth((scope) => new TraefikApp(scope, "app", { namespace: "edge" })).kubernetes_namespace, "edge")).toBeDefined();
    const r = release({ namespace: "edge", webTag: "v3.4.0" });
    expect(r).toMatchObject({ name: "traefik", chart: "traefik", version: "41.4.0" });
    expect(r?.set).toEqual([{ name: "service.spec.type", value: "NodePort" }]);
    const values = JSON.parse(r?.values?.[0] ?? "{}") as { ports: { web: { port: number }; websecure: { port: number } }; ingressClass: { enabled: boolean }; image: { tag: string } };
    expect(values.ports).toEqual({ web: { port: 18080 }, websecure: { port: 18443 } });
    expect(values.ingressClass.enabled).toBe(false);
    expect(values.image.tag).toBe("v3.4.0");
  });

  it("holds no secret of its own in what it hands Helm", () => {
    expect(JSON.stringify(release({}))).not.toMatch(/password|token|secret/i);
  });

  it("refuses to deploy when it is not told how its Service is reached", () => {
    vi.stubEnv("APP_SERVICE_TYPE", "");
    expect(() => release({})).toThrow(/APP_SERVICE_TYPE/);
  });
});
