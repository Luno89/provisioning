/**
 * Per-GPU VRAM discovery.
 *
 * VRAM is the resource that actually decides whether an LLM deploys. Host RAM almost never binds:
 * constructs/vllm.ts and constructs/tabbyapi.ts each request only 6G of system memory, while a 27B
 * model at 6bpw across two cards wants ~10GiB of weights per GPU plus a KV cache that can dwarf it.
 * A capacity check that only knows host RAM and a GPU *count* is checking the resource that rarely
 * binds and ignoring the one that usually does.
 *
 * Kubernetes will not tell us. `status.allocatable` exposes `nvidia.com/gpu: "2"` — a count, never
 * a size — so this has to come from somewhere else:
 *
 *   1. GPU Feature Discovery's node label `nvidia.com/gpu.memory` (MiB). Free to read and works on
 *      remote clusters, but only if GFD is installed; the device plugin alone does not publish it.
 *   2. `nvidia-smi` on the host. Authoritative, but only reachable for clusters that share a
 *      machine with this process — which includes the always-on management cluster, where the
 *      GPUs actually live.
 *
 * Absent means UNKNOWN, never zero. Everything downstream must degrade to "cannot tell" rather
 * than "no VRAM", the same rule the rest of the capacity model follows.
 */

/** GPU Feature Discovery publishes this in MiB. */
export const GFD_MEMORY_LABEL = 'nvidia.com/gpu.memory';

interface NodeLike {
  metadata?: { labels?: Record<string, string> };
  status?: { allocatable?: Record<string, string> };
}

/**
 * Reads per-GPU VRAM from GFD node labels.
 *
 * Takes the MINIMUM across nodes rather than the max, unlike the rest of the capacity model. A pod
 * lands on one node and gets one GPU, so in a mixed fleet the smallest card is what a deployment
 * has to fit inside — reporting the largest would green-light a model that only fits on one node.
 */
export function vramMibFromNodeLabels(payload: unknown): number | undefined {
  const items = (payload as { items?: NodeLike[] } | undefined)?.items;
  if (!Array.isArray(items)) return undefined;

  let smallest: number | undefined;
  for (const node of items) {
    // Only consider nodes that actually expose a GPU; a CPU-only node carries no useful label and
    // would otherwise drag the minimum to nothing.
    const gpuCount = Number(node?.status?.allocatable?.['nvidia.com/gpu'] ?? 0);
    if (!Number.isFinite(gpuCount) || gpuCount <= 0) continue;

    const raw = node?.metadata?.labels?.[GFD_MEMORY_LABEL];
    const mib = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(mib) || mib <= 0) continue;

    smallest = smallest === undefined ? mib : Math.min(smallest, mib);
  }
  return smallest;
}

/**
 * Parses `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`, one MiB value per
 * line. Returns the smallest, for the same reason as above.
 */
export function parseNvidiaSmiVram(stdout: string): number | undefined {
  const values = stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return values.length ? Math.min(...values) : undefined;
}

/** MiB → GiB, one decimal. VRAM is universally discussed in binary units, unlike host RAM pricing. */
export function vramGib(mib: number): number {
  return Math.round((mib / 1024) * 10) / 10;
}

/**
 * Whether an estimated per-GPU requirement fits, with headroom.
 *
 * The 10% reserve is not padding for a bad estimate — it covers what the estimate structurally
 * omits: CUDA context, activations, fragmentation, and whatever the display server is already
 * holding. A model sized to exactly 100% of VRAM reliably OOMs on load.
 */
export const VRAM_HEADROOM = 0.9;

export function vramVerdict(
  estimatedBytesPerGpu: number | undefined,
  availableMib: number | undefined,
): { fits: boolean; usableBytes: number; message?: string } | undefined {
  if (!estimatedBytesPerGpu || !availableMib) return undefined;

  const usableBytes = availableMib * 1024 * 1024 * VRAM_HEADROOM;
  if (estimatedBytesPerGpu <= usableBytes) return { fits: true, usableBytes };

  return {
    fits: false,
    usableBytes,
    message:
      `Estimated ${(estimatedBytesPerGpu / 1e9).toFixed(1)} GB per GPU, but each GPU has ` +
      `${vramGib(availableMib)} GiB (usable ~${(usableBytes / 1e9).toFixed(1)} GB after headroom). ` +
      `Reduce the context length, use a smaller quantisation, or add GPUs.`,
  };
}
