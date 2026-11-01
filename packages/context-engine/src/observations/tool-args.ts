function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function toolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    const parsed = jsonOf(raw);
    return isRecord(parsed) ? parsed : {};
  }
  return isRecord(raw) ? raw : {};
}
