
export const GFD_MEMORY_LABEL = 'nvidia.com/gpu.memory';

interface NodeLike {
  metadata?: { labels?: Record<string, string> };
  status?: { allocatable?: Record<string, string> };
}

export function vramMibFromNodeLabels(payload: unknown): number | undefined {
  const items = (payload as { items?: NodeLike[] } | undefined)?.items;
  if (!Array.isArray(items)) return undefined;

  let smallest: number | undefined;
  for (const node of items) {
    const gpuCount = Number(node?.status?.allocatable?.['nvidia.com/gpu'] ?? 0);
    if (!Number.isFinite(gpuCount) || gpuCount <= 0) continue;

    const raw = node?.metadata?.labels?.[GFD_MEMORY_LABEL];
    const mib = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(mib) || mib <= 0) continue;

    smallest = smallest === undefined ? mib : Math.min(smallest, mib);
  }
  return smallest;
}

export function parseNvidiaSmiVram(stdout: string): number | undefined {
  const values = stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return values.length ? Math.min(...values) : undefined;
}

export function vramGib(mib: number): number {
  return Math.round((mib / 1024) * 10) / 10;
}

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
