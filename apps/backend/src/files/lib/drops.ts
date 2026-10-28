import { isSafeRepoDir, isSafeRepoFilePath } from './project-file-paths.js';

export const DROP_TYPE = 'application/vnd.koala.drop';
export const MAX_DROP_LINE = 64 * 1024;

export interface DropSettings {
  dir: string;
  ref?: string | undefined;
  message?: string | undefined;
  leafId?: string | undefined;
}

export interface DroppedFile {
  path: string;
  source: string;
  size: number;
}

export type DropEvent =
  | { kind: 'settings'; settings: DropSettings }
  | { kind: 'file'; path: string; size: number }
  | { kind: 'bytes'; chunk: Buffer }
  | { kind: 'fileEnd' }
  | { kind: 'refused'; why: string };

const joined = (dir: string, path: string): string => [dir, path].map((part) => part.replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

const CONTROL = /[\u0000-\u001f\u007f]/;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function dropLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

export function dropBody(settings: Partial<DropSettings>, files: readonly { path: string; bytes: Buffer }[]): Buffer {
  return Buffer.concat([dropLine(settings), ...files.flatMap((file) => [dropLine({ path: file.path, size: file.bytes.length }), file.bytes])]);
}

export class DropReader {
  private state: 'settings' | 'entry' | 'bytes' | 'refused' = 'settings';
  private line: Buffer[] = [];
  private lineLength = 0;
  private remaining = 0;
  private dir = '';
  private current = '';
  private files = 0;
  private readonly seen = new Set<string>();

  push(chunk: Buffer): DropEvent[] {
    const events: DropEvent[] = [];
    let at = 0;
    while (at < chunk.length && this.state !== 'refused') {
      if (this.state === 'bytes') {
        const take = Math.min(this.remaining, chunk.length - at);
        events.push({ kind: 'bytes', chunk: chunk.subarray(at, at + take) });
        at += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          events.push({ kind: 'fileEnd' });
          this.state = 'entry';
        }
        continue;
      }
      const newline = chunk.indexOf(0x0a, at);
      const end = newline === -1 ? chunk.length : newline;
      this.lineLength += end - at;
      if (this.lineLength > MAX_DROP_LINE) {
        events.push(this.refuse('a line of the drop is too long to name a file'));
        break;
      }
      this.line.push(chunk.subarray(at, end));
      if (newline === -1) break;
      at = newline + 1;
      const said = Buffer.concat(this.line).toString('utf8');
      this.line = [];
      this.lineLength = 0;
      events.push(...this.take(said));
    }
    return events;
  }

  finish(): DropEvent[] {
    if (this.state === 'refused') return [];
    if (this.state === 'bytes') return [this.refuse(`the drop ended before all of ${this.current} arrived`)];
    if (this.lineLength > 0) return [this.refuse('the drop ended part way through naming a file')];
    if (this.files === 0) return [this.refuse('nothing was dropped')];
    return [];
  }

  private refuse(why: string): DropEvent {
    this.state = 'refused';
    return { kind: 'refused', why };
  }

  private take(said: string): DropEvent[] {
    let value: unknown;
    try {
      value = JSON.parse(said);
    } catch {
      return [this.refuse('the drop is not in the shape Koala reads')];
    }
    const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    if (this.state === 'settings') {
      const dir = typeof input.dir === 'string' ? input.dir : '';
      if (!isSafeRepoDir(dir) || CONTROL.test(dir)) return [this.refuse(`${dir} is not a folder inside the repository`)];
      this.dir = dir;
      this.state = 'entry';
      return [{ kind: 'settings', settings: { dir, ref: text(input.ref), message: text(input.message), leafId: text(input.leafId) } }];
    }
    const size = input.size;
    if (typeof input.path !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return [this.refuse('each dropped file needs a path and its size')];
    }
    const path = joined(this.dir, input.path);
    if (!isSafeRepoFilePath(path) || CONTROL.test(path)) return [this.refuse(`${input.path} would land outside the repository`)];
    if (this.seen.has(path)) return [this.refuse(`${path} was dropped twice`)];
    this.seen.add(path);
    this.files += 1;
    this.current = path;
    if (size === 0) return [{ kind: 'file', path, size }, { kind: 'fileEnd' }];
    this.remaining = size;
    this.state = 'bytes';
    return [{ kind: 'file', path, size }];
  }
}

export function dropMessage(files: readonly Pick<DroppedFile, 'path'>[], said?: string): string {
  if (said?.trim()) return said.trim();
  return files.length === 1 ? `Add ${files[0]!.path}` : `Add ${files.length} files`;
}
