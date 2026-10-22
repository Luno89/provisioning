import { isSafeRepoDir, isSafeRepoFilePath } from './project-file-paths.js';

export const DROP_TYPE = 'application/vnd.koala.drop+json';

export interface DroppedFile {
  path: string;
  bytes: Buffer;
}

export type DropReading = { ok: true; files: DroppedFile[] } | { ok: false; why: string };

const joined = (dir: string, path: string): string => [dir, path].map((part) => part.replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

export function readDrop(body: unknown): DropReading {
  const input = body as { dir?: unknown; files?: unknown } | undefined;
  const dir = typeof input?.dir === 'string' ? input.dir : '';
  if (!isSafeRepoDir(dir)) return { ok: false, why: `${dir} is not a folder inside the repository` };
  if (!Array.isArray(input?.files) || input.files.length === 0) return { ok: false, why: 'nothing was dropped' };
  const files: DroppedFile[] = [];
  const seen = new Set<string>();
  for (const entry of input.files as { path?: unknown; content?: unknown }[]) {
    if (typeof entry?.path !== 'string' || typeof entry.content !== 'string') return { ok: false, why: 'each dropped file needs a path and its content' };
    const path = joined(dir, entry.path);
    if (!isSafeRepoFilePath(path)) return { ok: false, why: `${entry.path} would land outside the repository` };
    if (seen.has(path)) return { ok: false, why: `${path} was dropped twice` };
    seen.add(path);
    files.push({ path, bytes: Buffer.from(entry.content, 'base64') });
  }
  return { ok: true, files };
}

export function dropMessage(files: readonly Pick<DroppedFile, 'path'>[], said?: string): string {
  if (said?.trim()) return said.trim();
  return files.length === 1 ? `Add ${files[0]!.path}` : `Add ${files.length} files`;
}
