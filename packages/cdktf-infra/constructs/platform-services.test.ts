import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { platformService } from "./platform-services.js";
import { platformSettingsFrom, PLATFORM_SERVICES, type PlatformInputs, type PlatformServiceName } from "../lib/platform-settings.js";

interface Pin { kind: string; name: string; version: string; source?: string }
const pins = (JSON.parse(readFileSync(new URL("../../../dependencies.pins.json", import.meta.url), "utf8")) as { components: Pin[] }).components;
const pinned = (kind: string, name: string) => pins.find((pin) => pin.kind === kind && pin.name === name);

interface Container { image: string; ports?: unknown[]; env?: unknown[]; resources?: unknown }
interface Spec {
  type?: string;
  ports?: unknown[];
  template: { metadata: { annotations?: Record<string, string> }; spec: { containers: Container[]; volumes?: unknown[] } };
  resources: { requests: { storage: string } };
}
interface KubeObject { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; annotations?: Record<string, string> }; spec?: Spec; data?: Record<string, string> }
interface Release { name: string; chart: string; version: string; repository: string; namespace: string; wait: boolean; set?: { name: string; value: string; type?: string }[]; set_sensitive?: { name: string; value: string }[]; depends_on?: string[] }
interface Synth {
  import?: { to: string; id: string }[];
  data?: { kubernetes_secret_v1?: Record<string, { metadata: { name: string; namespace: string } }> };
  resource: {
    kubernetes_manifest?: Record<string, { manifest: KubeObject; field_manager?: { force_conflicts: boolean }; depends_on?: string[] }>;
    kubernetes_config_map?: Record<string, { metadata: { name: string; namespace: string }; data: Record<string, string>; lifecycle?: { ignore_changes: string[] }; depends_on?: string[] }>;
    helm_release?: Record<string, Release>;
  };
}

const inputs = (over: Partial<PlatformInputs> = {}): PlatformInputs => ({ existing: new Set(), koalaNamespace: "nowrinkles", pool: false, stamp: "0123456789abcdef", ...over });
const synth = (name: PlatformServiceName, over: Partial<PlatformInputs> = {}): Synth & { text: string } => {
  const text = Testing.synthScope((scope) => { platformService(scope as never, name, inputs(over)); });
  return { ...(JSON.parse(text) as Synth), text };
};
const objects = (s: Synth): KubeObject[] => Object.values(s.resource.kubernetes_manifest ?? {}).map((entry) => entry.manifest);
const object = (s: Synth, kind: string, name: string) => objects(s).find((o) => o.kind === kind && o.metadata.name === name);
const releases = (s: Synth): Release[] => Object.values(s.resource.helm_release ?? {});
const setOf = (release: Release | undefined): Record<string, string> => Object.fromEntries((release?.set ?? []).map((entry) => [entry.name, entry.value]));
const container = (deployment: KubeObject | undefined): Container | undefined => deployment?.spec?.template.spec.containers[0];

describe("the platform services Koala puts on the cluster it runs in", () => {
  it("are applied in the order they need one another", () => {
    expect(PLATFORM_SERVICES).toEqual(["egress", "searxng", "crawl4ai", "gitea", "verdaccio", "infisical"]);
  });

  it("each makes what it makes once, taking over what is already there rather than failing on it", () => {
    const fresh = synth("verdaccio");
    expect(fresh.import ?? []).toEqual([]);
    const there = synth("verdaccio", { existing: new Set(["v1/Namespace//koala-registry", "apps/v1/Deployment/koala-registry/verdaccio"]) });
    expect(there.import).toEqual(expect.arrayContaining([
      { to: expect.stringMatching(/^kubernetes_manifest\./) as unknown, id: "apiVersion=v1,kind=Namespace,name=koala-registry" },
      { to: expect.stringMatching(/^kubernetes_manifest\./) as unknown, id: "apiVersion=apps/v1,kind=Deployment,namespace=koala-registry,name=verdaccio" },
    ]));
    expect(there.import).toHaveLength(2);
    for (const entry of Object.values(there.resource.kubernetes_manifest ?? {})) expect(entry.field_manager).toEqual({ force_conflicts: true });
  });

  it("hands Kubernetes each quantity in the form it reads back, so an apply never finds its own result changed", () => {
    expect(container(object(synth("searxng"), "Deployment", "searxng")).resources).toEqual({ limits: { memory: "1Gi", cpu: "1" }, requests: { memory: "256Mi", cpu: "100m" } });
    expect(container(object(synth("crawl4ai"), "Deployment", "crawl4ai")).resources).toEqual({ limits: { memory: "4Gi", cpu: "2" }, requests: { memory: "512Mi", cpu: "200m" } });
    expect(container(object(synth("verdaccio"), "Deployment", "verdaccio")).resources).toEqual({ limits: { memory: "1Gi", cpu: "1" }, requests: { memory: "128Mi", cpu: "50m" } });
    expect(object(synth("crawl4ai"), "Deployment", "crawl4ai")?.spec?.template.spec.volumes).toEqual([{ name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } }]);
  });

  it("makes each namespace before what goes in it", () => {
    const s = synth("searxng");
    const manifests = Object.entries(s.resource.kubernetes_manifest ?? {});
    const namespace = manifests.find(([, entry]) => entry.manifest.kind === "Namespace")![0];
    for (const [, entry] of manifests.filter(([, entry]) => entry.manifest.kind !== "Namespace")) expect(entry.depends_on).toContain(`kubernetes_manifest.${namespace}`);
  });
});

describe("the egress proxy", () => {
  const file = readFileSync(new URL("../../../k8s/koala-egress/egress-proxy.yaml", import.meta.url), "utf8");

  it("runs the proxy its manifest describes, restarted whenever its rules change", () => {
    const s = synth("egress");
    expect(object(s, "ConfigMap", "squid-conf")?.data?.["squid.conf"]).toContain("http_access deny all");
    const proxy = object(s, "Deployment", "egress-proxy");
    expect(container(proxy).image).toMatch(/^docker\.io\/ubuntu\/squid@sha256:[0-9a-f]{64}$/);
    expect(proxy?.spec?.template.metadata.annotations).toEqual({ "koala.dev/egress-config": createHash("sha256").update(file).digest("hex").slice(0, 16) });
    expect(object(s, "Service", "egress-proxy")?.spec?.ports).toEqual([{ port: 8888, targetPort: 8888 }]);
  });

  it("starts its grants empty and never overwrites the grants Koala wrote since", () => {
    const s = synth("egress", { existing: new Set(["v1/ConfigMap/koala-egress/egress-grants"]) });
    const grants = Object.entries(s.resource.kubernetes_config_map ?? {}).find(([, map]) => map.metadata.name === "egress-grants");
    expect(grants?.[1]).toMatchObject({ metadata: { namespace: "koala-egress" }, data: { passwd: "", "acls.conf": "" }, lifecycle: { ignore_changes: ["data"] } });
    expect(s.import).toContainEqual({ to: `kubernetes_config_map.${grants![0]}`, id: "koala-egress/egress-grants" });
    const proxy = Object.values(s.resource.kubernetes_manifest ?? {}).find((entry) => entry.manifest.kind === "Deployment");
    expect(proxy?.depends_on).toContain(`kubernetes_config_map.${grants![0]}`);
  });
});

describe("SearXNG and Crawl4AI", () => {
  for (const [name, port, secret, key, variable] of [["searxng", 8080, "searxng-secret", "secret_key", "SEARXNG_SECRET"], ["crawl4ai", 11235, "crawl4ai-secret", "api_token", "CRAWL4AI_API_TOKEN"]] as const) {
    it(`${name} answers only Koala's own pods, inside the cluster`, () => {
      const s = synth(name);
      const service = object(s, "Service", name);
      expect(service?.spec?.type ?? "ClusterIP").toBe("ClusterIP");
      expect(JSON.stringify(service)).not.toContain("nodePort");
      expect(object(s, "NetworkPolicy", "koala-only")).toEqual({
        apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "koala-only", namespace: name },
        spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "nowrinkles" } } }] }] },
      });
      expect(container(object(s, "Deployment", name)).ports).toEqual([{ containerPort: port }]);
    });

    it(`${name} reads its secret from the Secret Koala made, holds no value of it, and restarts when it changes`, () => {
      const s = synth(name, { stamp: "feedfacecafebeef" });
      expect(objects(s).some((o) => o.kind === "Secret")).toBe(false);
      expect(s.text).not.toMatch(/koala-dev-searxng-key|\$\{CRAWL4AI_API_TOKEN\}/);
      const deployment = object(s, "Deployment", name);
      expect(container(deployment).env).toContainEqual({ name: variable, valueFrom: { secretKeyRef: { name: secret, key } } });
      expect(deployment?.spec?.template.metadata.annotations).toEqual({ "koala.dev/secret": "feedfacecafebeef" });
    });
  }
});

describe("Gitea", () => {
  const gitea = (pool: boolean) => releases(synth("gitea", { pool })).find((release) => release.chart === "gitea");

  it("installs the pinned chart from its pinned repository, leaving Koala to watch it come up", () => {
    expect(gitea(false)).toMatchObject({ name: "gitea", namespace: "gitea", version: pinned("chart", "gitea")!.version, repository: pinned("chart", "gitea")!.source, wait: false });
  });

  it("runs the very Gitea version the tests run, from the one pin, rather than whatever the chart defaults to", () => {
    expect(setOf(gitea(false))["image.tag"]).toBe(pinned("binary", "gitea-server")!.version);
  });

  it("signs its admin in from the Secret Koala made, and holds no password of its own", () => {
    const release = gitea(false);
    expect(setOf(release)).toMatchObject({ "gitea.admin.existingSecret": "gitea-admin", "gitea.admin.email": "bot@provisioning.local", "gitea.admin.passwordMode": "keepUpdated" });
    expect(JSON.stringify(release)).not.toMatch(/admin\.password"/);
  });

  it("runs one Postgres, no Valkey cluster, replaced rather than rolled, private to its signed-in users and able to call Koala back", () => {
    expect(setOf(gitea(false))).toMatchObject({
      "postgresql.enabled": "true", "postgresql-ha.enabled": "false", "valkey-cluster.enabled": "false", "strategy.type": "Recreate",
      "gitea.config.security.ALLOWED_HOST_LIST": "private\\,loopback", "gitea.config.service.REQUIRE_SIGNIN_VIEW": "true", "gitea.config.service.DEFAULT_USER_VISIBILITY": "private",
      "gitea.config.server.ROOT_URL": "http://gitea-http.gitea.svc.cluster.local:3000/",
    });
  });

  it("serves its registry on the node's pinned port on a person's machine, and only inside the cluster on Koala's servers", () => {
    expect(setOf(gitea(false))).toMatchObject({ "service.http.type": "NodePort", "service.http.nodePort": "31737", "service.ssh.type": "ClusterIP" });
    expect(setOf(gitea(true))).toMatchObject({ "service.http.type": "ClusterIP", "service.ssh.type": "ClusterIP" });
    expect(setOf(gitea(true))["service.http.nodePort"]).toBeUndefined();
  });

  it("makes the account pipeline builds run as, with no access to the cluster's API", () => {
    expect(object(synth("gitea"), "ServiceAccount", "pipeline-build-sa")).toMatchObject({ metadata: { namespace: "pipeline-builds" }, automountServiceAccountToken: false });
  });
});

describe("the npm registry mirror", () => {
  it("runs the pinned Verdaccio, keeping its packages on a volume, mirroring npm", () => {
    const s = synth("verdaccio");
    expect(container(object(s, "Deployment", "verdaccio")).image).toBe(`verdaccio/verdaccio:${pinned("image", "verdaccio/verdaccio")!.version}`);
    expect(object(s, "PersistentVolumeClaim", "verdaccio-storage-pvc")?.spec?.resources.requests.storage).toBe("20Gi");
    expect(object(s, "ConfigMap", "verdaccio-config")?.data?.["config.yaml"]).toContain("url: https://registry.npmjs.org/");
    expect(object(s, "ConfigMap", "verdaccio-config")?.data?.["config.yaml"]).toContain("access: $all");
    expect(object(s, "Service", "verdaccio")?.spec?.ports).toEqual([{ port: 4873, targetPort: 4873 }]);
  });
});

describe("Infisical", () => {
  const s = () => synth("infisical");

  it("installs the pinned standalone chart and then the pinned secrets operator, from their pinned repository", () => {
    const [standalone, operator] = [releases(s()).find((r) => r.chart === "infisical-standalone"), releases(s()).find((r) => r.chart === "secrets-operator")];
    expect(standalone).toMatchObject({ name: "infisical", namespace: "infisical", version: pinned("chart", "infisical-standalone")!.version, repository: pinned("chart", "infisical-standalone")!.source, wait: false });
    expect(operator).toMatchObject({ name: "infisical-operator", namespace: "infisical", version: pinned("chart", "secrets-operator")!.version, wait: false });
    expect(operator?.depends_on?.some((ref) => ref.startsWith("helm_release."))).toBe(true);
  });

  it("serves only inside the cluster, with no ingress of its own, one Postgres and one Redis", () => {
    expect(setOf(releases(s()).find((r) => r.chart === "infisical-standalone"))).toMatchObject({
      "infisical.service.type": "ClusterIP", "ingress.enabled": "false", "ingress.nginx.enabled": "false",
      "postgresql.enabled": "true", "redis.enabled": "true", "redis.cluster.enabled": "false",
    });
  });

  it("runs one Infisical within 512Mi, set where the chart reads them, so a person's machine holds one copy", () => {
    expect(setOf(releases(s()).find((r) => r.chart === "infisical-standalone"))).toMatchObject({
      "infisical.replicaCount": "1",
      "infisical.resources.limits.memory": "512Mi",
      "infisical.resources.requests.memory": "256Mi",
      "infisical.resources.requests.cpu": "100m",
    });
  });

  it("hands its stores their passwords from the Secret Koala made, never as values in the stack", () => {
    const synthesized = s();
    const standalone = releases(synthesized).find((r) => r.chart === "infisical-standalone");
    const read = Object.entries(synthesized.data?.kubernetes_secret_v1 ?? {});
    expect(read.map(([, secret]) => secret.metadata)).toEqual([{ name: "infisical-store-passwords", namespace: "infisical" }]);
    expect(standalone?.set_sensitive).toEqual([
      { name: "postgresql.auth.password", value: `\${data.kubernetes_secret_v1.${read[0]![0]}.data["postgres"]}` },
      { name: "redis.auth.password", value: `\${data.kubernetes_secret_v1.${read[0]![0]}.data["redis"]}` },
    ]);
    expect(JSON.stringify(standalone?.set)).not.toMatch(/password|ENCRYPTION_KEY|AUTH_SECRET/i);
  });
});

describe("what a platform stack is told", () => {
  const env = { PLATFORM_SERVICE: "gitea", PLATFORM_EXISTING: '["helm/gitea/gitea"]', KOALA_NAMESPACE: "nowrinkles", POOL: "false", SECRET_STAMP: "0123456789abcdef" };

  it("reads which service, what is already there, whose namespace and where it runs", () => {
    expect(platformSettingsFrom(env)).toEqual({ name: "gitea", inputs: { existing: new Set(["helm/gitea/gitea"]), koalaNamespace: "nowrinkles", pool: false, stamp: "0123456789abcdef" } });
  });

  it("names every setting it is missing or cannot read, rather than guessing", () => {
    expect(() => platformSettingsFrom({})).toThrow(/PLATFORM_SERVICE.*\n.*PLATFORM_EXISTING.*\n.*KOALA_NAMESPACE.*\n.*POOL.*\n.*SECRET_STAMP/s);
    expect(() => platformSettingsFrom({ ...env, PLATFORM_SERVICE: "mail" })).toThrow("PLATFORM_SERVICE is mail; the platform services are egress, searxng, crawl4ai, gitea, verdaccio, infisical");
    expect(() => platformSettingsFrom({ ...env, PLATFORM_EXISTING: "gitea" })).toThrow("PLATFORM_EXISTING is not a JSON list of what is already on the cluster");
    expect(() => platformSettingsFrom({ ...env, POOL: "maybe" })).toThrow("POOL is maybe; it is true on Koala's servers and false on a person's machine");
  });
});
