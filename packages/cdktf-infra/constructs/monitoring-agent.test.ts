import { Testing } from "cdktf";
import { describe, expect, it } from "vitest";
import { AgentMonitoringStack, METRICS_CLIENT_SECRET, type MetricsSending } from "./monitoring-agent.js";

type Releases = Record<string, { name: string; chart: string; namespace: string; values?: string[] }>;

const SENDING: MetricsSending = {
  url: "http://100.64.0.7:30320/api/machines/metrics",
  tokenUrl: "https://koala.example/oidc/token",
  resource: "urn:koala:instance:inst-1",
};

const releasesOf = (sending: MetricsSending): Releases =>
  (JSON.parse(Testing.synthScope((scope) => { new AgentMonitoringStack(scope, "monitoring", sending); })) as { resource: { helm_release: Releases } }).resource.helm_release;

describe("monitoring on a machine's cluster", () => {
  it("collects in agent mode and sends everything to its Koala with a token it takes from root as a client of its own, keeping no Grafana, Alertmanager or rules of its own", () => {
    const releases = Object.values(releasesOf(SENDING));
    const stack = releases.find((release) => release.chart === "kube-prometheus-stack")!;
    const values = JSON.parse(stack.values![0]!) as Record<string, Record<string, unknown>>;
    expect(values.prometheus).toEqual({
      agentMode: true,
      prometheusSpec: {
        remoteWrite: [{
          url: "http://100.64.0.7:30320/api/machines/metrics",
          oauth2: {
            clientId: { secret: { name: METRICS_CLIENT_SECRET.name, key: METRICS_CLIENT_SECRET.idKey } },
            clientSecret: { name: METRICS_CLIENT_SECRET.name, key: METRICS_CLIENT_SECRET.secretKey },
            tokenUrl: "https://koala.example/oidc/token",
            scopes: ["koala:metrics"],
            endpointParams: { resource: "urn:koala:instance:inst-1" },
          },
        }],
      },
    });
    expect(JSON.stringify(values)).not.toContain("authorization");
    expect([values.grafana, values.alertmanager, values.defaultRules]).toEqual([{ enabled: false }, { enabled: false }, { create: false }]);
    expect(JSON.stringify(stack)).not.toContain("token\":\"");
  });

  it("probes its apps with a blackbox exporter of its own, by the name every app's Probe names", () => {
    const releases = Object.values(releasesOf(SENDING));
    expect(releases.map((release) => [release.name, release.namespace]).sort()).toEqual([["blackbox-exporter", "monitoring"], ["kube-prometheus-stack", "monitoring"]]);
  });
});
