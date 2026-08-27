/**
 * What a tree type says about the shape of the files it produces.
 *
 * ── WHY THIS EXISTS ──
 * A planner decomposes a request before anyone has read the repository, so it guesses paths. That
 * guess used to be unconstrained, and it cost a whole tree: on a `language: 'node'` type whose
 * scaffold is plain JavaScript, the planner wrote `expects: ['src/tools.ts']`. The agent did the
 * work correctly, said so — *"this project uses plain JavaScript … the correct file is
 * src/tools.js"* — and was refused three times, because `leaf-artifacts.ts` could not find
 * `src/tools.ts`. All 34 tests passed. The leaf failed anyway, and its branch never settled.
 *
 * ── WHY IT IS DERIVED AND NOT DECLARED ──
 * The obvious fix is a `fileConventions` field on the type. It is the wrong one: it would be a
 * second statement of something the template already makes, and the two would drift. `api-service`
 * could then claim `.ts` while shipping `src/server.js`, and nothing would catch it.
 *
 * The SCAFFOLD is the statement. `files[]` holds real paths that a real repository starts from, so
 * the extensions and directories in it are the convention, by construction. `language` is only the
 * fallback, for a type that ships no scaffold because it operates on a repository that already
 * exists — `migration` is the example.
 *
 * Pure, so the derivation can be tested against the shipped seeds directly.
 */
import type { WorkspaceLanguage } from './workspace-spec.js';
import type { TreeTypeSpec } from './tree-types.js';

export interface FileConventions {
  language: WorkspaceLanguage;
  /** Source extensions this template actually uses, most common first. Never empty. */
  sourceExts: string[];
  /** Directories the scaffold puts code in, e.g. ['src','test']. Empty when it ships no scaffold. */
  dirs: string[];
}

/**
 * What a language means when the template ships nothing to read.
 *
 * Ordered: the first entry is what a planner should be told to write. The rest are accepted as
 * equivalent, because a repository that already exists may legitimately use any of them.
 */
const LANGUAGE_EXTS: Record<WorkspaceLanguage, string[]> = {
  node: ['.js', '.mjs', '.cjs'],
  python: ['.py'],
  go: ['.go'],
  base: [],
};

/**
 * Extensions that describe a FORMAT rather than a language.
 *
 * Never rewritten between one another: a leaf asked for `NOTES.md` wants markdown, and offering it
 * `NOTES.js` would be the same class of mistake this module exists to stop, pointing the other way.
 */
const FORMAT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.html', '.css', '.svg', '.png', '.jpg', '.pdf', '.lock', '.sh', '.env', '.sql',
]);

const extensionOf = (p: string): string => {
  const base = p.split('/').pop() ?? p;
  const dot = base.lastIndexOf('.');
  // A leading dot is a dotfile (`.gitignore`), not an extension.
  return dot > 0 ? base.slice(dot) : '';
};

export function conventionsOf(treeType: TreeTypeSpec | undefined): FileConventions | undefined {
  if (!treeType) return undefined;
  const language = treeType.language;
  const files = treeType.files ?? [];

  // Source extensions the scaffold demonstrates, in first-seen order, formats excluded.
  const seen: string[] = [];
  for (const f of files) {
    const ext = extensionOf(f.path);
    if (ext && !FORMAT_EXTS.has(ext) && !seen.includes(ext)) seen.push(ext);
  }

  // Directories the scaffold puts files in. Root-level files name no directory.
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

/**
 * The same path under the extensions this template actually uses.
 *
 * Returns [] when there is nothing to offer — the path already conforms, carries no extension, or
 * names a format rather than a language. Empty means "no opinion", which callers treat as today's
 * behaviour rather than as a correction.
 */
export function extensionVariants(path: string, conventions: FileConventions): string[] {
  const ext = extensionOf(path);
  if (!ext || FORMAT_EXTS.has(ext)) return [];
  if (conventions.sourceExts.includes(ext)) return [];
  const stem = path.slice(0, path.length - ext.length);
  return conventions.sourceExts.map((e) => `${stem}${e}`);
}

/**
 * One line for a planner's system prompt, composed beside `doneMeans`.
 *
 * Deliberately a sentence rather than a schema: it goes into a system message next to
 * "This project is a …", and a JSON blob there reads as data the model may ignore.
 */
export function describeConventions(c: FileConventions): string {
  const ext = c.sourceExts[0];
  const parts = [`This is a ${c.language} project.`];
  if (ext) parts.push(`Source files end in ${ext}.`);
  if (c.dirs.length > 0) parts.push(`Code lives under ${c.dirs.join('/ and ')}/.`);
  parts.push('Name the paths you expect using those conventions.');
  return parts.join(' ');
}
