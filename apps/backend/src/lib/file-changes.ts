import { globPattern } from './release-paths.js';

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  path: string;
  from?: string | undefined;
  status: FileChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
  patch: string;
}

export interface ReleaseFile extends FileChange {
  inApp: boolean;
}

const HEADER = /^diff --git a\/(.+) b\/(.+)$/;

function unquote(name: string): string {
  return name.startsWith('"') && name.endsWith('"') ? JSON.parse(name) as string : name;
}

function changeOf(lines: string[]): FileChange {
  const header = HEADER.exec(lines[0] ?? '');
  let path = unquote(header?.[2] ?? '');
  let from: string | undefined;
  let status: FileChangeStatus = 'modified';
  let binary = false;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of lines.slice(1)) {
    if (!inHunk) {
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('rename from ')) { status = 'renamed'; from = unquote(line.slice('rename from '.length)); }
      else if (line.startsWith('rename to ')) path = unquote(line.slice('rename to '.length));
      else if (line.startsWith('Binary files ')) binary = true;
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { path, ...(from !== undefined ? { from } : {}), status, added, removed, binary, patch: lines.join('\n') };
}

export function parseDiff(diff: string): FileChange[] {
  const files: string[][] = [];
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (HEADER.test(line)) files.push([line]);
    else files.at(-1)?.push(line);
  }
  return files.map(changeOf);
}

export function sortedForRelease(files: readonly FileChange[], releaseWhen: readonly string[] | undefined): ReleaseFile[] {
  const patterns = (releaseWhen ?? []).map(globPattern);
  const inApp = (path: string) => patterns.length === 0 || patterns.some((pattern) => pattern.test(path));
  return files
    .map((file) => ({ ...file, inApp: inApp(file.path) || (file.from !== undefined && inApp(file.from)) }))
    .sort((a, b) => Number(b.inApp) - Number(a.inApp) || a.path.localeCompare(b.path));
}
