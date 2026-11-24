import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PG_SERVER_BIN, PG_ROOT } from './postgres-server.js';

const laidOut = (versions: Record<string, boolean>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pg-root-'));
  for (const [version, server] of Object.entries(versions)) {
    mkdirSync(join(root, version, 'bin'), { recursive: true });
    if (server) { writeFileSync(join(root, version, 'bin', 'initdb'), '#!/bin/sh\n'); chmodSync(join(root, version, 'bin', 'initdb'), 0o755); }
  }
  return root;
};

const picked = (root: string): { out: string; code: number } => {
  try {
    return { out: execFileSync('sh', ['-c', `set -eu\n${PG_SERVER_BIN.split(PG_ROOT).join(root)}\necho "$pgbin"`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), code: 0 };
  } catch (err) {
    return { out: String((err as { stderr?: string }).stderr ?? '').trim(), code: (err as { status?: number }).status ?? -1 };
  }
};

describe('the PostgreSQL server an Odoo check starts', () => {
  it('is the newest one installed with its server, passing over newer client tools beside it', () => {
    const root = laidOut({ '17': true, '19': false, '9.6': true });
    expect(picked(root)).toEqual({ out: join(root, '17', 'bin'), code: 0 });
  });

  it('is refused with why when only client tools are installed', () => {
    const root = laidOut({ '19': false });
    expect(picked(root)).toEqual({ out: `no PostgreSQL server is installed here: no initdb under ${root}`, code: 1 });
  });
});
