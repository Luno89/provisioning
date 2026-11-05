import { Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { AgentMonitoringStack, METRICS_TOKEN_SECRET } from "./monitoring-agent.js";

type Releases = Record<string, { name: string; chart: string; namespace: string; values?: string[] }>;

const releasesOf = (url: string): Releases =>
  (JSON.parse(Testing.synthScope((scope) => { new AgentMonitoringStack(scope, "monitoring", url); })) as { resource: { helm_release: Releases } }).resource.helm_release;

describe("monitoring on a machine's cluster", () => {
  it("collects in agent mode and sends everything to its Koala with the cluster's token, keeping no Grafana, Alertmanager or rules of its own", () => {
    const releases = Object.values(releasesOf("http://100.64.0.7:30320/api/machines/metrics"));
    const stack = releases.find((release) => release.chart === "kube-prometheus-stack")!;
    const values = JSON.parse(stack.values![0]!) as Record<string, Record<string, unknown>>;
    expect(values.prometheus).toEqual({
      agentMode: true,
      prometheusSpec: { remoteWrite: [{ url: "http://100.64.0.7:30320/api/machines/metrics", authorization: { type: "Bearer", credentials: { name: METRICS_TOKEN_SECRET, key: "token" } } }] },
    });
    expect([values.grafana, values.alertmanager, values.defaultRules]).toEqual([{ enabled: false }, { enabled: false }, { create: false }]);
    expect(JSON.stringify(stack)).not.toContain("token\":\"");
  });

  it("probes its apps with a blackbox exporter of its own, by the name every app's Probe names", () => {
    const releases = Object.values(releasesOf("http://koala/api/machines/metrics"));
    expect(releases.map((release) => [release.name, release.namespace]).sort()).toEqual([["blackbox-exporter", "monitoring"], ["kube-prometheus-stack", "monitoring"]]);
  });
});
