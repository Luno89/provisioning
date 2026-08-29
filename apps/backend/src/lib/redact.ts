
export const REDACTED = '[redacted]';

const MIN_KNOWN_LENGTH = 8;

const PATTERNS: { name: string; re: RegExp; replace: (m: string, ...rest: string[]) => string }[] = [
  {
    name: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    name: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  },
  {
    name: 'prefixed-token',
    re: /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,})\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'assigned-secret',
    re: /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|bearer)\s*[=:]\s*)(["']?)([^\s"'&,;]{8,})\2/gi,
    replace: (_m, lead, quote) => `${lead}${quote}${REDACTED}${quote}`,
  },
];

export function redactSecrets(text: string, known: readonly (string | undefined)[] = []): string {
  if (!text) return text;
  let out = text;

  for (const secret of known) {
    if (!secret || secret.length < MIN_KNOWN_LENGTH) continue;
    out = out.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }

  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
  }

  return out;
}

export function redactDeep<T>(value: T, known: readonly (string | undefined)[] = [], depth = 0): T {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactSecrets(value, known) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, known, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, known, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
