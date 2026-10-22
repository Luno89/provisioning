
export interface ProbeResult {
  unreachable?: string | undefined;
  tools: number;
}

export function healthFromProbe(probe: ProbeResult | undefined): { reason: string } | undefined {
  if (!probe) return undefined;
  if (probe.unreachable) return { reason: describeProbeFailure(probe.unreachable) };
  if (probe.tools === 0) return { reason: 'answers but offers no tools' };
  return undefined;
}

export function describeProbeFailure(raw: string): string {
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}
