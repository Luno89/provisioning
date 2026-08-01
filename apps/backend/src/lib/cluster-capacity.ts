/**
 * Cluster capacity, read from a node's `status.allocatable`.
 *
 * Why this exists: `vllm.ts` defaults to a 20G memory limit and 10 CPUs. Deploy that onto a node
 * smaller than that and the pod sits in `Pending` with "Insufficient memory" — indefinitely. No
 * deploy-time error, no failed status; the cluster reports healthy and the app simply never starts.
 * That is the worst failure shape for a self-serve product, because it reads as "the platform is
 * broken" rather than "you need a bigger box".
 *
 * ── RAM IS NOT VRAM ──
 * Kubernetes exposes GPUs as a COUNT (`nvidia.com/gpu: "2"`) and never a size, so VRAM cannot come
 * from `allocatable` — it arrives separately via GPU Feature Discovery labels or nvidia-smi (see
 * lib/gpu-vram.ts) and lives in its own `gpuVramMib` field. The RAM field is named `ramGb` rather
 * than `memoryGb` for the same reason `vps-catalog/types.ts` names its field `ramGb`: on a GPU box
 * the two numbers are wildly different (a Vultr `vcg-a40-96c-480g-192vram` has 480GB of system RAM
 * and 192GB of VRAM) and a single "memory" field is an invitation to conflate them.
 *
 * Apple Silicon is the exception that proves the point: its memory is unified, so RAM and VRAM are
 * one physical pool. That is a reason to model inference endpoints separately from clusters, not a
 * reason to merge the fields here.
 */
import { vramMibFromNodeLabels } from './gpu-vram.js';

/** What a cluster can offer. Absent fields mean "not measured", never "zero" — see checkCapacity. */
export interface ClusterCapacity {
  /** Allocatable CPU of the largest single node, in whole/fractional cores. */
  cpuCores: number;
  /** Allocatable memory of the largest single node, in GiB. System RAM. Never VRAM. */
  ramGb: number;
  /** GPUs on the largest single node — a COUNT, not a size. Absent when the cluster has none. */
  gpuCount?: number;
  gpuVendor?: 'nvidia' | 'amd';
  /**
   * Per-GPU VRAM in MiB — the SIZE that gpuCount deliberately is not, and the resource that
   * actually decides whether an LLM deploys (see lib/gpu-vram.ts).
   *
   * Absent means unknown, never zero: Kubernetes does not publish it, so it depends on GPU Feature
   * Discovery being installed or on nvidia-smi being reachable. Strictly separate from ramGb, which
   * is system memory.
   */
  gpuVramMib?: number;
}

const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

// Kubernetes uses SI decimal suffixes alongside the binary ones, and they are NOT the same:
// 20G is 20e9 bytes (18.6 GiB), not 20 GiB. Mixing them up understates a requirement by ~7%,
// which is exactly the size of error that looks like a flaky scheduler rather than a unit bug.
const DECIMAL_SUFFIXES: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/**
 * Parses a Kubernetes memory quantity to bytes. Handles `16265432Ki` (what nodes actually report),
 * `20G`, `8Gi`, plain byte counts, and exponent notation. Returns undefined for anything else
 * rather than guessing — a wrong number here silently blocks or admits a deploy.
 */
export function parseMemoryQuantity(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  const match = /^([0-9.]+(?:[eE][-+]?[0-9]+)?)([EPTGMK]i|[kKMGTPE])?$/.exec(text);
  if (!match || match[1] === undefined) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const suffix = match[2];
  if (!suffix) return value;
  const multiplier = BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix];
  return multiplier === undefined ? undefined : value * multiplier;
}

/**
 * Parses a Kubernetes CPU quantity to cores. `"8"` is 8 cores; `"7900m"` is 7.9 — millicores are
 * the normal shape for allocatable, since the kubelet reserves a slice for itself.
 */
export function parseCpuQuantity(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  const milli = /^([0-9.]+)m$/.exec(text);
  if (milli && milli[1] !== undefined) {
    const v = Number(milli[1]);
    return Number.isFinite(v) ? v / 1000 : undefined;
  }
  const v = Number(text);
  return Number.isFinite(v) ? v : undefined;
}

interface NodeLike {
  status?: { allocatable?: Record<string, string> };
}

/**
 * Extracts capacity from a `kubectl get nodes -o json` payload.
 *
 * Reports the maximum of each field ACROSS nodes rather than the sum, because a single pod cannot
 * span nodes: three 8GB nodes do not run a 20GB pod. Taking each field's maximum independently can
 * overstate a mixed cluster (a 32GB CPU-only node plus a 16GB GPU node reads as 32GB + 1 GPU), and
 * that direction is deliberate — an over-estimate degrades to today's behaviour (the pod goes
 * Pending), whereas an under-estimate would block a deploy that would have worked.
 */
export function capacityFromNodes(payload: unknown): ClusterCapacity | undefined {
  const gpuVramMib = vramMibFromNodeLabels(payload);
  const items = (payload as { items?: NodeLike[] } | undefined)?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  let cpuCores = 0;
  let ramBytes = 0;
  let gpuCount = 0;
  let gpuVendor: 'nvidia' | 'amd' | undefined;

  for (const node of items) {
    const alloc = node?.status?.allocatable;
    if (!alloc) continue;
    cpuCores = Math.max(cpuCores, parseCpuQuantity(alloc['cpu']) ?? 0);
    ramBytes = Math.max(ramBytes, parseMemoryQuantity(alloc['memory']) ?? 0);

    const nvidia = Number(alloc['nvidia.com/gpu'] ?? 0);
    const amd = Number(alloc['amd.com/gpu'] ?? 0);
    if (Number.isFinite(nvidia) && nvidia > gpuCount) {
      gpuCount = nvidia;
      gpuVendor = 'nvidia';
    }
    if (Number.isFinite(amd) && amd > gpuCount) {
      gpuCount = amd;
      gpuVendor = 'amd';
    }
  }

  if (cpuCores === 0 && ramBytes === 0) return undefined;

  return {
    cpuCores: Math.round(cpuCores * 100) / 100,
    ramGb: Math.round((ramBytes / 1024 ** 3) * 10) / 10,
    ...(gpuCount > 0 ? { gpuCount, ...(gpuVendor ? { gpuVendor } : {}) } : {}),
    ...(gpuVramMib ? { gpuVramMib } : {}),
  };
}

/**
 * What an app needs to be SCHEDULABLE, expressed as the same quantity strings the CDKTF constructs
 * use so the two cannot drift apart in units.
 *
 * These are the constructs' `requests`, NOT their `limits`. Kubernetes schedules on requests; a
 * limit only caps usage afterwards. Both vllm.ts and tabbyapi.ts request 6G while limiting to
 * 20G/32G respectively, so checking the limit would refuse a deploy that schedules perfectly well
 * on a 16GB box — a false rejection, which is the one direction this module is not willing to err
 * in (see capacityFromNodes).
 *
 * What the limit governs is whether the app runs WELL: a pod limited to 32G on a 30GiB node gets
 * OOMKilled under real load rather than refused up front. That is a genuine gap this check does not
 * cover, and covering it would mean modelling live usage rather than static capacity.
 */
export const APP_RESOURCE_NEEDS: Record<string, { memory: string; label: string }> = {
  // packages/cdktf-infra/constructs/vllm.ts — resources.requests.memory
  vllm: { memory: '6G', label: 'vLLM' },
  // packages/cdktf-infra/constructs/tabbyapi.ts — resources.requests.memory
  tabbyapi: { memory: '6G', label: 'TabbyAPI' },
};

/**
 * Returns a human-readable reason the app cannot fit, or undefined if it fits or if we cannot tell.
 *
 * Unknown capacity NEVER blocks. Clusters provisioned before capacity was recorded have no numbers
 * at all, and refusing to deploy to them would be a regression far worse than the Pending pod this
 * is meant to prevent.
 */
export function checkCapacity(
  appType: string,
  capacity: ClusterCapacity | undefined,
  requestedGpus?: number,
): string | undefined {
  if (!capacity) return undefined;

  const need = APP_RESOURCE_NEEDS[appType];
  if (need) {
    const needBytes = parseMemoryQuantity(need.memory);
    const haveBytes = capacity.ramGb * 1024 ** 3;
    if (needBytes !== undefined && haveBytes > 0 && needBytes > haveBytes) {
      const needGb = Math.round((needBytes / 1024 ** 3) * 10) / 10;
      return `${need.label} needs about ${needGb} GiB of RAM but this cluster's largest node has ${capacity.ramGb} GiB allocatable. The pod would stay Pending forever. Use a larger machine, or lower the app's memory limit.`;
    }
  }

  // Deliberately compares GPU COUNT to GPU COUNT. There is no VRAM number on either side of this
  // check and there cannot be one — see the module docstring.
  if (requestedGpus && requestedGpus > 0) {
    const available = capacity.gpuCount ?? 0;
    if (available === 0) {
      return `This deployment requests ${requestedGpus} GPU(s) but no GPUs are visible to the scheduler on this cluster. k3d clusters can never expose a GPU; a self-managed node needs the device plugin installed.`;
    }
    if (requestedGpus > available) {
      return `This deployment requests ${requestedGpus} GPU(s) but the largest node on this cluster has ${available}. A pod cannot span nodes, so it would stay Pending.`;
    }
  }

  return undefined;
}
