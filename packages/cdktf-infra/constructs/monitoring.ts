import { Construct } from "constructs";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { Release } from "../.gen/providers/helm/release";
import { Namespace } from "../.gen/providers/kubernetes/namespace";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../../");
const KUBECTL = path.join(PROJECT_ROOT, "bin", "kubectl");

// Only the management cluster (provisioning-lunorica) runs this platform's own Temporal workers
// (worker-host.ts/worker-cluster.ts) as bare host processes during local dev — a user-provisioned
// cluster has no such thing to scrape, so this only applies there.
const MANAGEMENT_CLUSTER_NAME = "provisioning-lunorica";

/**
 * Resolves the address Prometheus (running as a pod) can reach the worker processes at (running
 * on the bare host, not in a pod) — same InternalIP-lookup technique GiteaService.ts already
 * uses for the identical "reach the host from inside a pod" problem on native k3s. Best-effort:
 * returns undefined (skipping the scrape config entirely) rather than failing the whole cluster
 * deploy over an optional, cosmetic-only observability addition.
 */
function resolveHostIp(): string | undefined {
  try {
    const kubeconfig = process.env.KUBECONFIG_PATH || `${process.env.HOME}/.kube/config`;
    const raw = execFileSync(KUBECTL, [
      "--kubeconfig", kubeconfig,
      "get", "nodes", "-o",
      "jsonpath={.items[0].status.addresses[?(@.type==\"InternalIP\")].address}",
    ]).toString().trim();
    // A dual-stack node reports multiple InternalIP entries (IPv4 + IPv6) space-joined — same
    // parsing GiteaService.ts already needs for the same reason. IPv4 is always first.
    return raw.split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  }
}

export class MonitoringStack extends Construct {
  constructor(scope: Construct, id: string, clusterName?: string) {
    super(scope, id);

    const ns = new Namespace(this, "monitoring-ns", {
      metadata: {
        name: "monitoring",
      },
    });

    const hostIp = clusterName === MANAGEMENT_CLUSTER_NAME ? resolveHostIp() : undefined;

    new Release(this, "prometheus-stack", {
      name: "kube-prometheus-stack",
      repository: "https://prometheus-community.github.io/helm-charts",
      chart: "kube-prometheus-stack",
      namespace: ns.metadata.name,
      wait: false,
      set: [
        {
          name: "grafana.enabled",
          value: "true",
        },
      ],
      // worker-host.ts (:9465) and worker-cluster.ts (:9464), running as bare host processes
      // during local dev — not pods, so no PodMonitor/ServiceMonitor can target them (the
      // in-cluster *pod* form of worker-cluster.ts is separately covered by
      // k8s/worker-podmonitor.yaml). Exposes Temporal's own worker/activity metrics (task queue
      // poll rate, activity success/failure counts, latency) — the kind of thing that would have
      // shown "activity scheduled but no poller ever started it" immediately instead of needing
      // to query Temporal's raw event history by hand.
      ...(hostIp ? {
        values: [
          JSON.stringify({
            prometheus: {
              prometheusSpec: {
                additionalScrapeConfigs: [
                  {
                    job_name: "provisioning-host-workers",
                    static_configs: [
                      { targets: [`${hostIp}:9464`], labels: { worker: "cluster-worker" } },
                      { targets: [`${hostIp}:9465`], labels: { worker: "host-worker" } },
                    ],
                  },
                ],
              },
            },
          }),
        ],
      } : {}),
    });
  }
}
