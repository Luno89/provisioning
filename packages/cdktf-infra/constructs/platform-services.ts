import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ITerraformDependable } from "cdktf";
import { Construct } from "constructs";
import { ConfigMap } from "../.gen/providers/kubernetes/config-map/index.js";
import { DataKubernetesSecretV1 } from "../.gen/providers/kubernetes/data-kubernetes-secret-v1/index.js";
import { Release, type ReleaseSet, type ReleaseSetSensitive } from "../.gen/providers/helm/release/index.js";
import { chartRepository } from "../lib/chart-source.js";
import { HELM_CEILING_SECONDS } from "../lib/helm-ceiling.js";
import { answeringOnly, objectKey, objectsIn, releaseKey, withPodAnnotations, type KubeObject } from "../lib/platform-objects.js";
import { PlatformManifests } from "./platform-manifests.js";
import type { PlatformInputs, PlatformServiceName } from "../lib/platform-settings.js";


export const GITEA_CHART_VERSION = "12.7.0";
export const GITEA_CHART_REPO = "https://dl.gitea.com/charts/";
export const INFISICAL_CHART_VERSION = "1.11.1";
export const INFISICAL_OPERATOR_CHART_VERSION = "v0.11.15";
export const INFISICAL_CHART_REPO = "https://dl.cloudsmith.io/public/infisical/helm-charts/helm/charts/";

const manifestFile = (path: string): string => fileURLToPath(new URL(`../../../k8s/${path}`, import.meta.url));
const namespace = (name: string): KubeObject => ({ apiVersion: "v1", kind: "Namespace", metadata: { name } });

function release(scope: Construct, id: string, inputs: PlatformInputs, config: { name: string; namespace: string; chart: string; version: string; repository: string; set: ReleaseSet[]; setSensitive?: ReleaseSetSensitive[]; dependsOn: ITerraformDependable[] }): Release {
  const made = new Release(scope, id, {
    wait: false,
    timeout: HELM_CEILING_SECONDS,
    name: config.name,
    namespace: config.namespace,
    chart: config.chart,
    version: config.version,
    repository: chartRepository(config.repository),
    set: config.set,
    ...(config.setSensitive ? { setSensitive: config.setSensitive } : {}),
    dependsOn: config.dependsOn,
  });
  if (inputs.existing.has(releaseKey(config.namespace, config.name))) made.importFrom(`${config.namespace}/${config.name}`);
  return made;
}

const plain = (values: Record<string, string>): ReleaseSet[] => Object.entries(values).map(([name, value]) => ({ name, value }));
const strings = (values: Record<string, string>): ReleaseSet[] => Object.entries(values).map(([name, value]) => ({ name, value, type: "string" }));

export class EgressProxyPlatform extends Construct {
  constructor(scope: Construct, id: string, inputs: PlatformInputs) {
    super(scope, id);
    const file = manifestFile("koala-egress/egress-proxy.yaml");
    const rules = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
    const manifests = new PlatformManifests(this, "proxy", withPodAnnotations(objectsIn(file), "egress-proxy", { "koala.dev/egress-config": rules }), inputs.existing);
    const grants = new ConfigMap(this, "grants", {
      metadata: { name: "egress-grants", namespace: "koala-egress" },
      data: { passwd: "", "acls.conf": "" },
      lifecycle: { ignoreChanges: ["data"] },
      dependsOn: manifests.namespaces,
    });
    if (inputs.existing.has(objectKey({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "egress-grants", namespace: "koala-egress" } }))) grants.importFrom("koala-egress/egress-grants");
    manifests.dependOn("Deployment", "egress-proxy", grants);
  }
}

export class InsideKoalaPlatform extends Construct {
  constructor(scope: Construct, id: string, service: "searxng" | "crawl4ai", inputs: PlatformInputs) {
    super(scope, id);
    const objects = withPodAnnotations(objectsIn(manifestFile(`${service}/${service}.yaml`)), service, { "koala.dev/secret": inputs.stamp });
    new PlatformManifests(this, service, [...objects, answeringOnly(service, inputs.koalaNamespace)], inputs.existing);
  }
}

export class GiteaPlatform extends Construct {
  constructor(scope: Construct, id: string, inputs: PlatformInputs) {
    super(scope, id);
    const place = new PlatformManifests(this, "namespace", [namespace("gitea")], inputs.existing);
    release(this, "gitea", inputs, {
      name: "gitea",
      namespace: "gitea",
      chart: "gitea",
      version: GITEA_CHART_VERSION,
      repository: GITEA_CHART_REPO,
      dependsOn: place.namespaces,
      set: [
        ...plain({
          "gitea.admin.existingSecret": "gitea-admin",
          "gitea.admin.email": "bot@provisioning.local",
          "gitea.admin.passwordMode": "keepUpdated",
          ...(inputs.pool
            ? { "service.http.type": "ClusterIP", "service.ssh.type": "ClusterIP" }
            : { "service.http.type": "NodePort", "service.http.nodePort": "31737", "service.ssh.type": "ClusterIP" }),
          "postgresql.enabled": "true",
          "postgresql-ha.enabled": "false",
          "valkey-cluster.enabled": "false",
          "strategy.type": "Recreate",
        }),
        ...strings({
          "gitea.config.server.ROOT_URL": "http://gitea-http.gitea.svc.cluster.local:3000/",
          "gitea.config.security.ALLOWED_HOST_LIST": "private\\,loopback",
          "gitea.config.service.REQUIRE_SIGNIN_VIEW": "true",
          "gitea.config.service.DEFAULT_USER_VISIBILITY": "private",
        }),
      ],
    });
    new PlatformManifests(this, "pipeline-builds", objectsIn(manifestFile("pipeline-build-sa.yaml")), inputs.existing);
  }
}

export class VerdaccioPlatform extends Construct {
  constructor(scope: Construct, id: string, inputs: PlatformInputs) {
    super(scope, id);
    new PlatformManifests(this, "verdaccio", objectsIn(manifestFile("verdaccio/verdaccio.yaml")), inputs.existing);
  }
}

export class InfisicalPlatform extends Construct {
  constructor(scope: Construct, id: string, inputs: PlatformInputs) {
    super(scope, id);
    const place = new PlatformManifests(this, "namespace", [namespace("infisical")], inputs.existing);
    const stores = new DataKubernetesSecretV1(this, "store-passwords", { metadata: { name: "infisical-store-passwords", namespace: "infisical" } });
    const standalone = release(this, "standalone", inputs, {
      name: "infisical",
      namespace: "infisical",
      chart: "infisical-standalone",
      version: INFISICAL_CHART_VERSION,
      repository: INFISICAL_CHART_REPO,
      dependsOn: place.namespaces,
      setSensitive: [
        { name: "postgresql.auth.password", value: stores.data.lookup("postgres") },
        { name: "redis.auth.password", value: stores.data.lookup("redis") },
      ],
      set: plain({
        "infisical.service.type": "ClusterIP",
        "postgresql.enabled": "true",
        "redis.enabled": "true",
        "redis.cluster.enabled": "false",
        "ingress.enabled": "false",
        "ingress.nginx.enabled": "false",
      }),
    });
    release(this, "operator", inputs, {
      name: "infisical-operator",
      namespace: "infisical",
      chart: "secrets-operator",
      version: INFISICAL_OPERATOR_CHART_VERSION,
      repository: INFISICAL_CHART_REPO,
      dependsOn: [standalone],
      set: [],
    });
  }
}

export function platformService(scope: Construct, name: PlatformServiceName, inputs: PlatformInputs): void {
  switch (name) {
    case "egress": new EgressProxyPlatform(scope, "egress", inputs); return;
    case "searxng": new InsideKoalaPlatform(scope, "searxng", "searxng", inputs); return;
    case "crawl4ai": new InsideKoalaPlatform(scope, "crawl4ai", "crawl4ai", inputs); return;
    case "gitea": new GiteaPlatform(scope, "gitea", inputs); return;
    case "verdaccio": new VerdaccioPlatform(scope, "verdaccio", inputs); return;
    case "infisical": new InfisicalPlatform(scope, "infisical", inputs); return;
  }
}
