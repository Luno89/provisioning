import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

export interface ChildEnvWorld {
  dir: string;
  bin: string;
  printsNames(name: string, to: 'out' | 'err', code: number): string;
}

export const namesIn = (said: string): string[] => said.split('\n').map((line) => line.trim()).filter(Boolean);

export function childEnvWorld(prefix: string, secrets: readonly string[]): ChildEnvWorld {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(dir, 'bin');
  const before: Record<string, string | undefined> = {};

  beforeAll(() => {
    mkdirSync(bin, { recursive: true });
    for (const name of [...secrets, 'PATH']) before[name] = process.env[name];
    for (const name of secrets) process.env[name] = `${name.toLowerCase()}-never-handed-on-to-a-child-process`;
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const printsNames = (name: string, to: 'out' | 'err', code: number): string => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nenv | cut -d= -f1 ${to === 'err' ? '>&2' : ''}\nexit ${code}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  return { dir, bin, printsNames };
}
