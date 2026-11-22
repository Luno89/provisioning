import { Testing } from "cdktf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { objectKey } from "../lib/platform-objects.js";
import { IngressStack } from "./ingress.js";
import { AgentMonitoringStack } from "./monitoring-agent.js";
import { MonitoringStack } from "./monitoring.js";
import { OperatorCrdsStack } from "./operator-crds.js";

interface Synth {
  resource: { kubernetes_namespace?: Record<string, { metadata: { name: string } }>; helm_release?: Record<string, { namespace: string; depends_on?: string[] }> };
  import?: { to: string; id: string }[];
}

const SENDING = { url: "http://100.64.0.7:30320/api/machines/metrics", tokenUrl: "https://koala.example/oidc/token", resource: "urn:koala:instance:inst-1" };
const namespaceKey = (name: string) => objectKey({ apiVersion: "v1", kind: "Namespace", metadata: { name } });

const stacks: Record<string, { namespace: string; build: (scope: never, existing: ReadonlySet<string>) => unknown }> = {
  "Koala's own monitoring": { namespace: "monitoring", build: (scope, existing) => new MonitoringStack(scope, "monitoring", existing) },
  "a machine's monitoring": { namespace: "monitoring", build: (scope, existing) => new AgentMonitoringStack(scope, "monitoring", SENDING, existing) },
  "the operator's CRDs": { namespace: "monitoring", build: (scope, existing) => new OperatorCrdsStack(scope, "monitoring", existing) },
  "the ingress": { namespace: "traefik", build: (scope, existing) => new IngressStack(scope, "ingress", existing) },
};

const synth = (build: (scope: never, existing: ReadonlySet<string>) => unknown, existing: ReadonlySet<string>): Synth =>
  JSON.parse(Testing.synthScope((scope) => { build(scope as never, existing); })) as Synth;

beforeEach(() => { vi.stubEnv("INGRESS_SERVICE", "NodePort"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the namespace a cluster stack puts its releases in", () => {
  for (const [what, { namespace, build }] of Object.entries(stacks)) {
    it(`${what}: holds ${namespace} itself, its releases waiting on it`, () => {
      const made = synth(build, new Set());
      const [id, held] = Object.entries(made.resource.kubernetes_namespace ?? {}).find(([, each]) => each.metadata.name === namespace) ?? [];
      expect(held, `${what} declares no namespace ${namespace}`).toBeDefined();
      expect(Object.values(made.resource.helm_release ?? {}).some((release) => JSON.stringify(release).includes(`kubernetes_namespace.${id!}`))).toBe(true);
      expect(made.import ?? []).toEqual([]);
    });

    it(`${what}: takes over ${namespace} when something else made it first`, () => {
      const made = synth(build, new Set([namespaceKey(namespace), namespaceKey("elsewhere")]));
      const [id] = Object.entries(made.resource.kubernetes_namespace ?? {}).find(([, each]) => each.metadata.name === namespace) ?? [];
      expect(made.import).toEqual([{ to: `kubernetes_namespace.${id!}`, id: namespace }]);
    });
  }
});
