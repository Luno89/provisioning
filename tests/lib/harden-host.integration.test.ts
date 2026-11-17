import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { excerptEnv, scriptExcerpt } from '../coupling/shell-trace.js';

const SCRIPT = new URL('../../scripts/root-node/harden-host.sh', import.meta.url).pathname;
const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'koala-harden-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const writing = (path: string, content: string) => spawnSync('bash', ['-c', scriptExcerpt(SCRIPT, ['write_if_changed'],
  `set -euo pipefail\ndie() { echo "$1" >&2; exit 1; }\nwrite_if_changed '${path}' <<'CONF'\n${content}\nCONF\necho "changed=$CHANGED"\n`)],
{ encoding: 'utf8', env: { ...process.env, ...excerptEnv() } });

describe('a setting root\'s hardening writes', () => {
  it('is written when it changed, said to have changed, and left alone when it is already so', () => {
    const file = join(scratch(), 'conf.d', '90-koala.conf');
    const first = writing(file, 'a = 1');
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('changed=1');
    expect(readFileSync(file, 'utf8')).toBe('a = 1\n');
    const written = statSync(file).mtimeMs;

    const again = writing(file, 'a = 1');
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('changed=0');
    expect(statSync(file).mtimeMs).toBe(written);
  });

  it('stops the hardening, naming the file, when it cannot be written', () => {
    const blocker = join(scratch(), 'not-a-folder');
    writeFileSync(blocker, 'a file where a folder should be');
    const refused = writing(join(blocker, '90-koala.conf'), 'a = 1');
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain(`could not write ${join(blocker, '90-koala.conf')}`);
    expect(refused.stdout).not.toContain('changed=');
  });
});
