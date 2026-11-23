import { Testing } from "cdktf";
import type { Construct } from "constructs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudiobookshelfNativeApp } from "./audiobookshelf-native.js";
import { Crawl4aiNativeApp } from "./crawl4ai-native.js";
import { GitappApp } from "./gitapp.js";
import { HermesAgentApp } from "./hermes-agent.js";
import { HomeassistantNativeApp } from "./homeassistant-native.js";
import { ImmichNativeApp } from "./immich-native.js";
import { JellyfinNativeApp } from "./jellyfin-native.js";
import { KavitaNativeApp } from "./kavita-native.js";
import { MinioNativeApp } from "./minio-native.js";
import { NavidromeNativeApp } from "./navidrome-native.js";
import { NextcloudNativeApp } from "./nextcloud-native.js";
import { OdooNativeApp } from "./odoo-native.js";
import { OpenWebUiApp } from "./open-webui.js";
import { PalworldApp } from "./palworld.js";
import { PapraNativeApp } from "./papra-native.js";
import { PlexNativeApp } from "./plex-native.js";
import { SearxngNativeApp } from "./searxng-native.js";
import { SpecApp } from "./spec-app.js";
import { TabbyApiApp } from "./tabbyapi.js";
import { VerdaccioNativeApp } from "./verdaccio-native.js";
import { VllmApp } from "./vllm.js";
import { WordPressNativeApp } from "./wordpress-native.js";

interface Container { name: string; security_context?: { privileged?: boolean } }
interface Pod {
  service_account_name?: string;
  automount_service_account_token?: boolean;
  container?: Container[];
  init_container?: Container[];
  volume?: { name: string; host_path?: { path: string } }[];
}

const MODEL_CACHE = "/var/lib/rancher/model-cache";

function rightsProblems(build: (scope: Construct) => unknown, hostFolder?: string): string[] {
  const synthed = JSON.parse(Testing.synthScope((scope) => { build(scope); })) as { resource: { kubernetes_deployment?: Record<string, { metadata: { name: string }; spec: { template: { spec: Pod } } }> } };
  const deployments = Object.values(synthed.resource.kubernetes_deployment ?? {});
  if (deployments.length === 0) return ["no pod was synthesized"];
  return deployments.flatMap(({ metadata, spec: { template: { spec: pod } } }) => [
    ...(pod.service_account_name === undefined ? [] : [`${metadata.name} runs as service account ${pod.service_account_name}`]),
    ...(pod.automount_service_account_token === false ? [] : [`${metadata.name} mounts a service account token`]),
    ...[...(pod.container ?? []), ...(pod.init_container ?? [])].filter((c) => c.security_context?.privileged).map((c) => `${metadata.name}'s ${c.name} is privileged`),
    ...(pod.volume ?? []).filter((v) => v.host_path && v.host_path.path !== hostFolder).map((v) => `${metadata.name} mounts the host's ${v.host_path!.path}`),
  ]);
}

beforeEach(() => { vi.stubEnv("APP_SERVICE_TYPE", "NodePort"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("an app's pods run as nothing of Koala's", () => {
  const apps: [string, (scope: Construct) => unknown][] = [
    ["Audiobookshelf", (scope) => new AudiobookshelfNativeApp(scope, "app", {})],
    ["Crawl4AI", (scope) => new Crawl4aiNativeApp(scope, "app", {})],
    ["a project's own app", (scope) => new GitappApp(scope, "app", { webRepo: "gitea-http.gitea.svc.cluster.local:3000/u/shop", webTag: "a".repeat(40) })],
    ["Hermes", (scope) => new HermesAgentApp(scope, "app", { dashboardAuthPassword: "p" })],
    ["Home Assistant", (scope) => new HomeassistantNativeApp(scope, "app", {})],
    ["Immich", (scope) => new ImmichNativeApp(scope, "app", {})],
    ["Jellyfin", (scope) => new JellyfinNativeApp(scope, "app", {})],
    ["Kavita", (scope) => new KavitaNativeApp(scope, "app", {})],
    ["MinIO", (scope) => new MinioNativeApp(scope, "app", {})],
    ["Navidrome", (scope) => new NavidromeNativeApp(scope, "app", {})],
    ["Nextcloud", (scope) => new NextcloudNativeApp(scope, "app", {})],
    ["Odoo", (scope) => new OdooNativeApp(scope, "app", {})],
    ["Open WebUI", (scope) => new OpenWebUiApp(scope, "app", {})],
    ["Palworld", (scope) => new PalworldApp(scope, "app", {})],
    ["Papra", (scope) => new PapraNativeApp(scope, "app", {})],
    ["Plex", (scope) => new PlexNativeApp(scope, "app", {})],
    ["SearXNG", (scope) => new SearxngNativeApp(scope, "app", {})],
    ["Verdaccio", (scope) => new VerdaccioNativeApp(scope, "app", {})],
    ["WordPress", (scope) => new WordPressNativeApp(scope, "app", {})],
    ["an app from a spec", (scope) => new SpecApp(scope, "app", { rendered: {
      namespace: { metadata: { name: "tei" } },
      pvcs: [],
      deployment: { metadata: { name: "tei", namespace: "tei" }, spec: { selector: { matchLabels: { app: "tei" } }, template: { metadata: { labels: { app: "tei" } }, spec: { container: [{ name: "tei", image: "tei:1" }] } } } },
      service: { metadata: { name: "tei", namespace: "tei" }, spec: { port: [{ port: 80 }] } },
    } })],
    ["an app behind the VPN", (scope) => new JellyfinNativeApp(scope, "app", { vpnEnabled: true, vpnProtocol: "openvpn", vpnConfig: "client" })],
  ];

  for (const [name, build] of apps) {
    it(`${name}: no Koala account, no token, nothing privileged, no host folder`, () => {
      expect(rightsProblems(build)).toEqual([]);
    });
  }

  it("a model server: no Koala account, no token, nothing privileged, and of the host only the model cache", () => {
    expect(rightsProblems((scope) => new VllmApp(scope, "app", { image: "vllm/vllm-openai:v0.32.0", gpuVendor: "nvidia", gpuCount: 1, cachePvc: MODEL_CACHE }), MODEL_CACHE)).toEqual([]);
    expect(rightsProblems((scope) => new VllmApp(scope, "app", { image: "vllm/vllm-openai-rocm:v0.32.0", gpuVendor: "amd", gpuCount: 1, cachePvc: MODEL_CACHE }), MODEL_CACHE)).toEqual([]);
    expect(rightsProblems((scope) => new TabbyApiApp(scope, "app", { image: "ghcr.io/theroyallab/tabbyapi:latest", gpuCount: 1, modelSizeBytes: 20e9, cachePvc: MODEL_CACHE }), MODEL_CACHE)).toEqual([]);
  });
});
