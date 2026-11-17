export interface Reference { file: string; line: number; text: string; ref: string; kind: 'image' | 'chart-repository' }

const OWN = /^nowrinkles\//;
const COMMENT = /^\s*(?:\*|\/\/|\/\*|#(?!!))/;

const SKIPPED = /(\.test\.|\.integration\.test\.|\/testing\/|\.gen\/|node_modules|package-lock\.json|^tests\/|\.md$|^docs\/|dependencies\.pins\.json|^apps\/backend\/dist\/|^apps\/frontend\/public\/|^apps\/backend\/src\/eval\/|\.svg$|\.png$|\.gz$)/;
const SCANNED = /(\.(ts|tsx|mjs|js|sh|ya?ml|txt|toml|json|conf)$|Dockerfile$|Caddyfile$)/;

const FLOATING = 'latest|stable|release|main|edge|nightly|apache|stable-apache|alpine';
const TAG = `(?:v?\\d[\\w.+-]*|${FLOATING}|latest-[\\w.-]+|RELEASE\\.[\\w.-]+)`;
const NAME = '(?:[a-z0-9.-]+\\.[a-z]{2,}(?::\\d+)?\\/)?[a-z0-9][a-z0-9._-]*(?:\\/[a-z0-9][a-z0-9._-]*)*';
const IMAGE = new RegExp(`(?<![\\w./:@-])(${NAME}):(${TAG})(?:@sha256:[0-9a-f]{64})?(?![\\w:/.-]*[\\w/])`, 'g');
const DIGESTED = new RegExp(`(?<![\\w./:@-])(${NAME})@sha256:[0-9a-f]{64}`, 'g');
const CHART_REPOSITORY = /https:\/\/[a-z0-9.-]+(?:\/[\w.-]+)*\/[\w.-]*(?:helm-charts|charts)\/?(?:helm\/charts\/?)?(?=["'`\s]|$)|https:\/\/charts\.[a-z0-9.-]+(?=["'`\s/]|$)|https:\/\/temporal\.io\/charts/g;
const DEFAULTED = /\$\{[^}]*\|\|\s*["']([^"']+)["']\}:\$\{[^}]*?["']([^"']+)["']\s*\}/g;
const PAIRED = /(?:web|db|odoo|pg)Repo:\s*'([^']+)',\s*(?:web|db|odoo|pg)Tag:\s*'([^']*)'/g;
const HOSTS = /^(?:\d+\.\d+\.\d+\.\d+|localhost|host|inet|temporal|test|[\w-]+-\d+|.*\.(?:local|internal|svc|localhost)\.?)$/;
const CSS = /^(?:padding|margin|width|height|opacity|font-size|top|left|right|bottom|gap|z-index|flex|line-height)$/;
const NOT_IMAGES = /^(node|https?|localhost|127\.0\.0\.1|0\.0\.0\.0|sha256|v|tcp|udp|redis|mongodb|postgres(?:ql)?|smtp|file|data|blob|ws|wss|ssh|git|mailto|tel)$/;

export function referencesIn(file: string, text: string): Reference[] {
  if (SKIPPED.test(file) || !SCANNED.test(file)) return [];
  const found: Reference[] = [];
  text.split('\n').forEach((line, at) => {
    if (COMMENT.test(line)) return;
    for (const match of line.matchAll(IMAGE)) {
      const [ref, name, tag] = match as unknown as [string, string, string];
      if (NOT_IMAGES.test(name) && !/^\d/.test(tag)) continue;
      if (HOSTS.test(name) || CSS.test(name) || /^\d{3,}\.?$/.test(tag) || /^[\w.-]*-prometheus$|-exporter$|-http$/.test(name)) continue;
      if (name === 'node' && !/^\d+(?:[.-]|$)/.test(tag)) continue;
      if (/^\d+$/.test(tag) && /^\d+$/.test(name)) continue;
      if (/^[a-z]+$/.test(name) && /^\d{2}$/.test(tag) && /\d{2}:\d{2}/.test(line)) continue;
      if (OWN.test(name)) continue;
      found.push({ file, line: at + 1, text: line, ref, kind: 'image' });
    }
    for (const match of [...line.matchAll(DEFAULTED), ...line.matchAll(PAIRED)]) if (match[1] && match[1] !== 'text') found.push({ file, line: at + 1, text: line, ref: `${match[1]}:${match[2] || 'latest'}`, kind: 'image' });
    for (const match of line.matchAll(DIGESTED)) found.push({ file, line: at + 1, text: line, ref: match[0], kind: 'image' });
    for (const match of line.matchAll(CHART_REPOSITORY)) found.push({ file, line: at + 1, text: line, ref: match[0], kind: 'chart-repository' });
  });
  return found;
}

export interface Recorded { file: string; pattern: string }
export interface Unpinned { name: string; usedIn: string[] }

const linesHeld = (text: string, pattern: string): Set<number> => {
  const held = new Set<number>();
  for (const match of text.matchAll(new RegExp(pattern, 'gmd'))) {
    const span = match.indices?.[1];
    if (span) held.add(text.slice(0, span[0]).split('\n').length);
  }
  return held;
};

export function unrecorded(references: readonly Reference[], uses: readonly Recorded[], unpinned: readonly Unpinned[], read: (file: string) => string): Reference[] {
  const held = new Map<string, Set<number>>();
  for (const use of uses) {
    const lines = held.get(use.file) ?? new Set<number>();
    for (const line of linesHeld(read(use.file), use.pattern)) lines.add(line);
    held.set(use.file, lines);
  }
  return references.filter((reference) =>
    !held.get(reference.file)?.has(reference.line)
    && !unpinned.some((entry) => entry.usedIn.includes(reference.file) && reference.ref.startsWith(entry.name)));
}
