/**
 * Computes how much RAM tests/lib/disposable-vm.ts's test VM actually needs, instead of guessing
 * round numbers — confirmed live this session that guessing (2048 → 4096 → 6144 → 8192MB) burned
 * several full deploy-and-fail cycles before landing on a number that still wasn't right, because
 * the real driver (Loki's chunksCache/resultsCache memcached sub-charts defaulting to
 * production-scale ~9.8Gi/~1.2Gi memory *requests* — see LOKI_VALUES in constructs/logging.ts)
 * was never actually measured, just papered over with a bigger guess.
 *
 * Two sources feed the total, both clearly separated below:
 *  1. Real declared `requests.memory` from each chart, discovered via `helm template` against
 *     the exact same values each CDKTF construct deploys (LOKI_VALUES/PROMTAIL_VALUES imported
 *     directly from logging.ts, not duplicated — a first draft of this file hand-copied them and
 *     the copy was already subtly wrong, silently missing loki's schemaConfig).
 *  2. A documented TYPICAL_FOOTPRINT_MB table for components confirmed (via the same `helm
 *     template` check) to declare NO resources.requests at all — kube-prometheus-stack,
 *     blackbox-exporter, and traefik's charts all leave `resources: {}` by default, so summing
 *     "declared requests" alone would silently and confidently under-count them to zero despite
 *     each having a real, non-trivial memory footprint. These numbers are typical dev-scale
 *     observed usage, not discovered — flagged as such rather than presented as equally precise.
 *
 * Regex-scanned rather than YAML-parsed — this repo has no YAML parser dependency, and a
 * `requests:` block's `memory:` line is reliably shaped enough (Helm's own templates emit it
 * consistently) that a targeted regex is simpler than adding one just for this.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { LOKI_VALUES, PROMTAIL_VALUES } from '../../packages/cdktf-infra/constructs/logging.js';

const HELM = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'bin', 'helm');

// Every chart provisioning a cluster's cluster+observability stacks installs — repo/chart/values
// must match packages/cdktf-infra/constructs/*.ts exactly, or this undercounts.
const CHARTS: Array<{ name: string; repo: string; chart: string; values: Record<string, unknown> }> = [
  {
    name: 'kube-prometheus-stack',
    repo: 'https://prometheus-community.github.io/helm-charts',
    chart: 'kube-prometheus-stack',
    values: { grafana: { enabled: true } },
  },
  {
    name: 'loki',
    repo: 'https://grafana.github.io/helm-charts',
    chart: 'loki',
    values: LOKI_VALUES,
  },
  {
    name: 'promtail',
    repo: 'https://grafana.github.io/helm-charts',
    chart: 'promtail',
    values: PROMTAIL_VALUES,
  },
  {
    name: 'blackbox-exporter',
    repo: 'https://prometheus-community.github.io/helm-charts',
    chart: 'prometheus-blackbox-exporter',
    values: { fullnameOverride: 'blackbox-exporter' },
  },
  {
    name: 'traefik',
    repo: 'https://traefik.github.io/charts',
    chart: 'traefik',
    values: { ingressClass: { enabled: true }, service: { spec: { type: 'NodePort' } } },
  },
];

// Confirmed live via `helm template` against the exact values above: these charts declare zero
// resources.requests by default, so the scan below correctly (but misleadingly) finds 0MB for
// each. Real memory usage on a fresh, low-traffic dev cluster, from direct observation —
// deliberately conservative-but-real rather than production sizing-guide numbers, which run much
// higher (e.g. Prometheus scales with retention/cardinality far beyond this).
const TYPICAL_FOOTPRINT_MB: Record<string, number> = {
  'kube-prometheus-stack': 900, // prometheus ~450 + grafana ~150 + alertmanager ~50 + operator ~100 + kube-state-metrics ~50 + node-exporter ~30 + CRD/webhook jobs ~70
  'blackbox-exporter': 30,
  traefik: 80,
};

function parseMemory(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)(Mi|Gi|M|G|Ki|K)?$/);
  if (!match || !match[1]) return 0;
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case 'Gi': return n * 1024;
    case 'G': return n * 1000;
    case 'Ki': return n / 1024;
    case 'K': return n / 1000;
    case 'Mi':
    case 'M':
    default: return n;
  }
}

/** Sums every `memory:` value found inside a `requests:` block across a rendered manifest set. */
function sumRequestedMemoryMB(renderedYaml: string): number {
  let total = 0;
  const requestsBlockRe = /requests:\n((?:[ \t]+\S.*\n?)*)/g;
  let block: RegExpExecArray | null;
  while ((block = requestsBlockRe.exec(renderedYaml)) !== null) {
    const memoryLine = block[1]?.match(/memory:\s*"?(\d+(?:\.\d+)?(?:Mi|Gi|M|G|Ki|K)?)"?/);
    if (memoryLine?.[1]) total += parseMemory(memoryLine[1]);
  }
  return total;
}

/**
 * Returns the recommended VM memory (MB) for a full cluster+observability deploy: sum of every
 * chart's declared memory requests (falling back to a documented typical footprint for charts
 * that declare none), plus a fixed budget for k3s itself (control plane + containerd + coredns +
 * local-path-provisioner + metrics-server) and general OS overhead, times a safety margin
 * (requests aren't hard caps — real usage can run over, and scheduling needs slack to avoid the
 * exact "Insufficient memory" failure this was built to stop guessing around).
 */
export function calculateRequiredVmMemoryMB(): number {
  const K3S_AND_OS_OVERHEAD_MB = 1536;
  const SAFETY_MARGIN = 1.4;

  let chartTotal = 0;
  for (const c of CHARTS) {
    try {
      const rendered = execFileSync(HELM, [
        'template', c.name, c.chart,
        '--repo', c.repo,
        '--values', '-',
      ], { input: JSON.stringify(c.values), maxBuffer: 20 * 1024 * 1024 }).toString();
      let mb = sumRequestedMemoryMB(rendered);
      let source = 'requested';
      const typical = TYPICAL_FOOTPRINT_MB[c.name];
      if (mb === 0 && typical !== undefined) {
        mb = typical;
        source = 'typical, chart declares no request';
      }
      console.log(`  📐 ${c.name}: ${mb.toFixed(0)}MB (${source})`);
      chartTotal += mb;
    } catch (err: any) {
      console.warn(`  ⚠ Could not template ${c.name} for memory budgeting (${err.message.split('\n')[0]}) — excluded from budget, final number may be an undercount`);
    }
  }

  const total = Math.ceil((chartTotal + K3S_AND_OS_OVERHEAD_MB) * SAFETY_MARGIN);
  console.log(`  📐 Total: ${chartTotal.toFixed(0)}MB charts + ${K3S_AND_OS_OVERHEAD_MB}MB k3s/OS, ×${SAFETY_MARGIN} margin = ${total}MB`);
  return total;
}
