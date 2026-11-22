import { Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { BlackboxExporterStack } from "./blackbox-exporter.js";
import { AgentMonitoringStack } from "./monitoring-agent.js";
import { MonitoringStack } from "./monitoring.js";

type Releases = Record<string, { name: string; reuse_values?: boolean }>;

const releasesOf = (build: (scope: never) => unknown): Releases =>
  (JSON.parse(Testing.synthScope((scope) => { build(scope as never); })) as { resource: { helm_release: Releases } }).resource.helm_release;

describe("upgrading a cluster's monitoring to a newer chart", () => {
  it("keeps the values a cluster's releases hold, so how long history is kept and where it is stored survive the upgrade", () => {
    const releases = [
      ...Object.values(releasesOf((scope) => new MonitoringStack(scope, "monitoring"))),
      ...Object.values(releasesOf((scope) => new AgentMonitoringStack(scope, "monitoring", { url: "http://koala/api/machines/metrics", tokenUrl: "https://koala.example/oidc/token", resource: "urn:koala:instance:inst-1" }))),
      ...Object.values(releasesOf((scope) => new BlackboxExporterStack(scope, "blackbox"))),
    ];
    expect(releases.map((release) => [release.name, release.reuse_values]).sort()).toEqual([
      ["blackbox-exporter", true],
      ["blackbox-exporter", true],
      ["kube-prometheus-stack", true],
      ["kube-prometheus-stack", true],
    ]);
  });
});
