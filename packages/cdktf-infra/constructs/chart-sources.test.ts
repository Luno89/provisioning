import { readFileSync } from "node:fs";
import { Testing } from "cdktf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudiobookshelfApp } from "./audiobookshelf.js";
import { IngressStack } from "./ingress.js";
import { LoggingStack } from "./logging.js";
import { OperatorCrdsStack } from "./operator-crds.js";
import { PrometheusApp } from "./prometheus.js";
import { TelemetryStack } from "./telemetry.js";
import { TemporalApp } from "./temporal.js";
import { TraefikApp } from "./traefik.js";
import { platformService } from "./platform-services.js";

interface Pin { kind: string; name: string; source?: string }
const pins = (JSON.parse(readFileSync(new URL("../../../dependencies.pins.json", import.meta.url), "utf8")) as { components: Pin[] }).components;
const pinnedSource = (chart: string) => pins.find((pin) => pin.kind === "chart" && pin.name === chart)?.source;

type Releases = Record<string, { chart: string; repository: string }>;
const releasesOf = (build: (scope: never) => unknown): Releases =>
  (JSON.parse(Testing.synthScope((scope) => { build(scope as never); })) as { resource: { helm_release?: Releases } }).resource.helm_release ?? {};

const constructs: Record<string, (scope: never) => unknown> = {
  Audiobookshelf: (scope) => new AudiobookshelfApp(scope, "app"),
  ingress: (scope) => new IngressStack(scope, "ingress", new Set()),
  logging: (scope) => new LoggingStack(scope, "logging"),
  "operator CRDs": (scope) => new OperatorCrdsStack(scope, "crds", new Set()),
  Prometheus: (scope) => new PrometheusApp(scope, "app"),
  telemetry: (scope) => new TelemetryStack(scope, "telemetry", "monitoring"),
  Temporal: (scope) => new TemporalApp(scope, "app"),
  Traefik: (scope) => new TraefikApp(scope, "app"),
  "Koala's Gitea": (scope) => platformService(scope, "gitea", { existing: new Set(), koalaNamespace: "koala", pool: false, stamp: "s" }),
  "Koala's Infisical": (scope) => platformService(scope, "infisical", { existing: new Set(), koalaNamespace: "koala", pool: false, stamp: "s" }),
};

beforeEach(() => { vi.stubEnv("APP_SERVICE_TYPE", "NodePort"); vi.stubEnv("INGRESS_SERVICE", "NodePort"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("where every chart release reads its chart", () => {
  for (const [what, build] of Object.entries(constructs)) {
    it(`${what}: from its pinned repository, or with CHART_SOURCES set, from the address standing in for every one`, () => {
      vi.stubEnv("CHART_SOURCES", "");
      const pinned = Object.values(releasesOf(build));
      expect(pinned.length).toBeGreaterThan(0);
      for (const release of pinned) {
        expect(release.repository, release.chart).toMatch(/^https:\/\//);
        const source = pinnedSource(release.chart);
        if (source) expect(release.repository, release.chart).toBe(source);
      }
      vi.stubEnv("CHART_SOURCES", "http://127.0.0.1:4100");
      for (const release of Object.values(releasesOf(build))) {
        const was = pinned.find((entry) => entry.chart === release.chart)!.repository;
        expect(release.repository, release.chart).toBe(`http://127.0.0.1:4100/${was.replace(/^https:\/\//, "").replace(/\/+$/, "")}`);
      }
    });
  }
});
