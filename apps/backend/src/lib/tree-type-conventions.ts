import type { WorkspaceLanguage } from './workspace-spec.js';
import type { TreeTypeSpec } from './tree-types.js';

export interface FileConventions {
  language: WorkspaceLanguage;
  sourceExts: string[];
  dirs: string[];
}

const LANGUAGE_EXTS: Record<WorkspaceLanguage, string[]> = {
  node: ['.js', '.mjs', '.cjs'],
  python: ['.py'],
  go: ['.go'],
  base: [],
};

const FORMAT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.html', '.css', '.svg', '.png', '.jpg', '.pdf', '.lock', '.sh', '.env', '.sql',
]);

const extensionOf = (p: string): string => {
  const base = p.split('/').pop() ?? p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
};

export function conventionsOf(treeType: TreeTypeSpec | undefined): FileConventions | undefined {
  if (!treeType) return undefined;
  const language = treeType.language;
  const files = treeType.files ?? [];

  const seen: string[] = [];
  for (const f of files) {
    const ext = extensionOf(f.path);
    if (ext && !FORMAT_EXTS.has(ext) && !seen.includes(ext)) seen.push(ext);
  }

  const dirs: string[] = [];
  for (const f of files) {
    const head = f.path.includes('/') ? f.path.split('/')[0]! : '';
    if (head && !dirs.includes(head)) dirs.push(head);
  }

  return {
    language,
    sourceExts: seen.length > 0 ? seen : (LANGUAGE_EXTS[language] ?? []),
    dirs,
  };
}

export function extensionVariants(path: string, conventions: FileConventions): string[] {
  const ext = extensionOf(path);
  if (!ext || FORMAT_EXTS.has(ext)) return [];
  if (conventions.sourceExts.includes(ext)) return [];
  const stem = path.slice(0, path.length - ext.length);
  return conventions.sourceExts.map((e) => `${stem}${e}`);
}

export function describeConventions(c: FileConventions): string {
  const ext = c.sourceExts[0];
  const parts = [`This is a ${c.language} project.`];
  if (ext) parts.push(`Source files end in ${ext}.`);
  if (c.dirs.length > 0) parts.push(`Code lives under ${c.dirs.join('/ and ')}/.`);
  parts.push('Name the paths you expect using those conventions.');
  return parts.join(' ');
}
