#!/usr/bin/env -S npx tsx
/**
 * ensure-cluster-stack.ts — Idempotently applies the CDKTF ClusterStack (Prometheus + Grafana +
 * Alertmanager via MonitoringStack, Traefik via IngressStack, blackbox-exporter, Loki + Promtail
 * via LoggingStack, plus the dashboards/alert-rules/NetworkPolicy ConfigMaps/CRDs that ride along
 * with them) to the always-on management cluster.
 *
 * Every *other* cluster gets this automatically: provisioning one through the UI runs
 * ProvisionClusterActivity, which always ends with a `STACK_TYPE=cluster` CDKTF apply. The
 * management cluster never goes through that workflow — it's bootstrapped separately by
 * scripts/cluster.sh (pure k3s/k3d lifecycle, no CDKTF involved at all) — so nothing has ever
 * applied this stack to it. A `clean-dev` reset wipes whatever was there (even if installed
 * manually at some point) and nothing brings it back. This script is that missing step, run
 * from ensure-cluster.sh on every `npm run dev` with a cheap fast-path skip when already
 * installed, so it doesn't pay a full CDKTF-apply cost on every single dev-server start.
 */
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';

const CLUSTER_NAME = 'provisioning-lunorica';
const CONTEXT = `k3d-${CLUSTER_NAME}`;

// Every Helm release the ClusterStack installs (packages/cdktf-infra/main.ts) — kept as a plain
// list, not spot-checking just kube-prometheus-stack/traefik, so a partial/interrupted previous
// apply (e.g. Ctrl-C mid-deploy) doesn't get mistaken for "fully installed" and skipped forever.
// The PrometheusRule/NetworkPolicy/ConfigMap resources that ride along in the same `cdktf deploy`
// aren't separately checkable via `helm list` (they're not Helm releases), but since they're
// applied in that same run, "all releases present" is a reasonable proxy for "the whole stack
// landed" without needing a kubectl round-trip per resource kind.
const EXPECTED_RELEASES = ['kube-prometheus-stack', 'traefik', 'blackbox-exporter', 'loki', 'promtail'];

async function isInstalled(infra: InfrastructureService): Promise<boolean> {
  try {
    const releasesJson = await infra.runHelm(['list', '-A', '-o', 'json', '--kube-context', CONTEXT], undefined);
    const releases = JSON.parse(releasesJson);
    return EXPECTED_RELEASES.every((name) => releases.some((r: any) => r.name === name && r.status === 'deployed'));
  } catch {
    return false;
  }
}

async function main() {
  const infra = new InfrastructureService();

  if (await isInstalled(infra)) {
    console.log('  ▶  Monitoring/logging/ingress stack already installed on the management cluster — skipping');
    return;
  }

  console.log('  ▶  Installing monitoring/logging/ingress stack on the management cluster (first run, or post-reset)...');
  const logFile = infra.getLogPath('cluster-stack-provisioning-lunorica');
  const env = { STACK_TYPE: 'cluster', ENV: 'k3d', CLUSTER_NAME };
  try {
    // Two separate, sequential applies — not a preference, a hard requirement. The second
    // stack's `kubernetes_manifest` resources (PrometheusRule, etc.) resolve their target CRD's
    // schema at Terraform *plan* time against whatever the cluster's API server already has —
    // which only includes kube-prometheus-stack's CRDs once ClusterStack's own apply has actually
    // finished. Combining these into one `cdktf deploy` fails outright on a genuinely fresh
    // cluster ("no matches for kind PrometheusRule in group monitoring.coreos.com") even with an
    // explicit CDKTF-level dependency declared — confirmed live. See main.ts's ObservabilityStack
    // docstring for the full explanation.
    await infra.deploy(CLUSTER_NAME, { logFile, env, timeout: 10 * 60 * 1000 });
    await infra.deploy(`${CLUSTER_NAME}-observability`, { logFile, env, timeout: 10 * 60 * 1000 });
    console.log('  ✅ Monitoring/logging/ingress stack installed');
  } catch (err: any) {
    console.warn(`  ⚠️  Failed to install monitoring/logging/ingress stack: ${err.message}`);
    console.warn(`     See ${logFile} for details. Continuing — this doesn't block the rest of dev startup.`);
  }
}

main();
