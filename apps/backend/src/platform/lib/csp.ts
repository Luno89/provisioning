export type CspMode = 'off' | 'report' | 'enforce';

export const CSP_REPORT_PATH = '/csp-report';

export const SPA_POLICY: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'media-src': ["'self'", 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'report-uri': [CSP_REPORT_PATH],
};

export function cspModeFrom(env: Readonly<Record<string, string | undefined>>): CspMode {
  const asked = env.CSP?.trim().toLowerCase();
  if (asked === 'enforce' || asked === 'report' || asked === 'off') return asked;
  return env.NODE_ENV === 'production' ? 'enforce' : 'off';
}

export function policyText(policy: Readonly<Record<string, readonly string[]>> = SPA_POLICY): string {
  return Object.entries(policy).map(([directive, sources]) => `${directive} ${sources.join(' ')}`).join('; ');
}

export function cspHeader(mode: CspMode): { name: string; value: string } | undefined {
  if (mode === 'off') return undefined;
  return { name: mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', value: policyText() };
}

interface LegacyReport { 'csp-report'?: Record<string, unknown> }
interface ReportingApiReport { type?: string; body?: Record<string, unknown>; url?: string }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function violationLine(report: unknown): string | undefined {
  const entries: Record<string, unknown>[] = [];
  if (Array.isArray(report)) {
    for (const entry of report as ReportingApiReport[]) if (entry?.type === 'csp-violation' && entry.body) entries.push({ ...entry.body, ...(entry.url ? { 'document-uri': entry.url } : {}) });
  } else if (report && typeof report === 'object') {
    const legacy = (report as LegacyReport)['csp-report'];
    if (legacy) entries.push(legacy);
    else entries.push(report as Record<string, unknown>);
  }
  const lines = entries.flatMap((entry) => {
    const directive = text(entry['effective-directive']) ?? text(entry.effectiveDirective) ?? text(entry['violated-directive']) ?? text(entry.violatedDirective);
    if (!directive) return [];
    const blocked = text(entry['blocked-uri']) ?? text(entry.blockedURL) ?? 'inline';
    const page = text(entry['document-uri']) ?? text(entry.documentURL) ?? '';
    const where = text(entry['source-file']) ?? text(entry.sourceFile);
    const line = entry['line-number'] ?? entry.lineNumber;
    return [`${directive} blocked ${blocked}${page ? ` on ${page}` : ''}${where ? ` (${where}${line ? `:${line}` : ''})` : ''}`];
  });
  return lines.length ? lines.join('; ') : undefined;
}
