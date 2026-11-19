import { statfs } from 'node:fs/promises';
import type { CommandRunner } from './commands.js';
import type { Progress, Step } from './steps.js';

export interface RoomContext {
  commands: CommandRunner;
}

export interface RoomOptions {
  id: string;
  for: string;
  path: string;
  needs: number;
  free?: (path: string) => Promise<number>;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const LARGEST = 8;
const quiet: Progress = { line: () => undefined };

export function bytes(count: number): string {
  let unit = 0;
  let size = count;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${size} B` : `${size.toFixed(1)} ${UNITS[unit]}`;
}

export async function freeAt(path: string): Promise<number> {
  const found = await statfs(path);
  return found.bavail * found.bsize;
}

async function using(ctx: RoomContext, path: string): Promise<string> {
  const { stdout } = await ctx.commands.run({ command: 'du', args: ['-x', '-a', '-b', '-d', '1', path], accept: [0, 1] }, quiet);
  return stdout.split('\n').filter((line) => line.includes('\t')).map((line) => {
    const [size = '0', ...rest] = line.split('\t');
    return { size: Number(size), entry: rest.join('\t') };
  }).filter((one) => one.entry !== path).sort((a, b) => b.size - a.size).slice(0, LARGEST).map((one) => `${one.entry} (${bytes(one.size)})`).join(', ');
}

export async function roomStep(options: RoomOptions): Promise<Step<RoomContext>> {
  const free = options.free ?? freeAt;
  const short = (left: number): string => `only ${bytes(left)} is free in ${options.path}, and ${bytes(options.needs)} is needed for ${options.for}`;
  return {
    id: options.id,
    title: `Room in ${options.path}: ${bytes(await free(options.path))} free, ${bytes(options.needs)} needed for ${options.for}`,
    async check() {
      const left = await free(options.path);
      return left >= options.needs ? { done: true } : { done: false, why: short(left) };
    },
    async apply(ctx) {
      const left = await free(options.path);
      if (left >= options.needs) return;
      throw new Error(`${short(left)}; using it: ${await using(ctx, options.path)}`);
    },
  };
}
