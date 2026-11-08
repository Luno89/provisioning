export interface McpProbe {
  unreachable?: string | undefined;
  tools: number;
}

export const PROBE_TTL_MS = 10 * 60 * 1000;

export function cachedProbes<T extends { id: string }>(probe: (item: T) => Promise<McpProbe>, ttlMs = PROBE_TTL_MS, now: () => number = Date.now) {
  const seen = new Map<string, { at: number; result: McpProbe }>();
  return async (item: T): Promise<McpProbe> => {
    const known = seen.get(item.id);
    if (known && now() - known.at < ttlMs && !known.result.unreachable) return known.result;
    const result = await probe(item);
    seen.set(item.id, { at: now(), result });
    return result;
  };
}
