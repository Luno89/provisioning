import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnScript } from '../../../../tests/coupling/shell-trace.js';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/machine/machine.sh');
const NODE_VERSION = /^NODE_VERSION=(\S+)$/m.exec(readFileSync(SCRIPT, 'utf8'))![1]!;
const ROOT = 'http://root.test';
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function computer(options: { nodeThere?: boolean; bundleSha?: (real: string) => string } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'koala-machine-script-'));
  homes.push(home);
  const bin = path.join(home, 'bin');
  const share = path.join(home, '.local/share/koala');
  mkdirSync(bin, { recursive: true });
  if (options.nodeThere !== false) {
    mkdirSync(path.join(share, `node-v${NODE_VERSION}`, 'bin'), { recursive: true });
    symlinkSync(process.execPath, path.join(share, `node-v${NODE_VERSION}`, 'bin', 'node'));
  }
  const staged = path.join(home, 'staged');
  mkdirSync(staged);
  writeFileSync(path.join(staged, 'agent.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path.join(home, 'handed.json'))}, JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }));\n`);
  writeFileSync(path.join(staged, 'package.json'), '{"name":"koala-machine","version":"1.0.0","type":"module"}\n');
  const tarball = path.join(home, 'agent.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', staged, '.']);
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const fetched = path.join(home, 'fetched.log');
  const tool = (name: string, body: string) => { writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  tool('curl', [
    'out=""; url=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done',
    `echo "$url" >> '${fetched}'`,
    'case "$url" in',
    `  */api/machines/agent.tgz.sha256) echo "${(options.bundleSha ?? ((real: string) => real))(sha)}  machine-agent.tgz" ;;`,
    `  */api/machines/agent.tgz) cp '${tarball}' "$out" ;;`,
    '  https://nodejs.org/*) echo "not node" > "$out" ;;',
    '  *) exit 22 ;;',
    'esac',
  ].join('\n'));
  tool('npm', 'mkdir -p node_modules');
  const run = (args: string[]) => {
    rmSync(path.join(home, 'handed.json'), { force: true });
    const ran = spawnScript(SCRIPT, args, {
      posix: true,
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_DATA_HOME: path.join(home, '.local/share') },
    });
    const handed = existsSync(path.join(home, 'handed.json')) ? JSON.parse(readFileSync(path.join(home, 'handed.json'), 'utf8')) as { argv: string[]; path: string } : undefined;
    return { code: ran.status, said: `${ran.stdout}${ran.stderr}`, handed };
  };
  return { run, share, sha, fetched: () => (existsSync(fetched) ? readFileSync(fetched, 'utf8').trim().split('\n') : []) };
}

describe('machine.sh, the one-line entry of a machine\'s join', () => {
  it('installs the agent bundle root names, checked by its sha256, and hands the join to it with every argument', async () => {
    const here = computer();
    const ran = here.run(['--yes', '--folder', '/srv/koala', '--adapters', 'none', '--no-service', 'the-code']);
    expect(ran.code, ran.said).toBe(0);
    expect(ran.handed?.argv).toEqual(['join', '--url', '__KOALA_URL__', '--yes', '--folder', '/srv/koala', '--adapters', 'none', '--no-service', 'the-code']);
    expect(ran.handed?.path.split(':')[0]).toBe(path.join(here.share, `node-v${NODE_VERSION}`, 'bin'));
    expect(readFileSync(path.join(here.share, 'machine', 'bundle.sha256'), 'utf8')).toBe(`${here.sha}\n`);
    expect(ran.said).toContain('your own Node.js is left as it is');
  });

  it('fetches from the Koala the person names with --url, and hands that on', async () => {
    const here = computer();
    const ran = here.run(['--url', ROOT, 'the-code']);
    expect(ran.code, ran.said).toBe(0);
    expect(here.fetched()).toEqual([`${ROOT}/api/machines/agent.tgz.sha256`, `${ROOT}/api/machines/agent.tgz`]);
    expect(ran.handed?.argv.slice(0, 3)).toEqual(['join', '--url', ROOT]);
    expect(ran.handed?.argv.slice(-3)).toEqual(['--url', ROOT, 'the-code']);
  });

  it('keeps the agent it already has when root serves the same one', async () => {
    const here = computer();
    here.run(['--url', ROOT, 'first-code']);
    const again = here.run(['--url', ROOT, 'second-code']);
    expect(again.code, again.said).toBe(0);
    expect(here.fetched().filter((url) => url.endsWith('/agent.tgz'))).toHaveLength(1);
    expect(again.handed?.argv.at(-1)).toBe('second-code');
  });

  it('installs nothing and runs nothing when the bundle is not the one root named', async () => {
    const here = computer({ bundleSha: () => '0'.repeat(64) });
    const ran = here.run(['--url', ROOT, 'the-code']);
    expect(ran.code).not.toBe(0);
    expect(ran.said).toContain('the machine agent Koala sent is not the one it built (its sha256 differs); nothing was installed');
    expect(existsSync(path.join(here.share, 'machine'))).toBe(false);
    expect(ran.handed).toBeUndefined();
  });

  it('installs nothing when the Node.js it downloads is not the one Koala pins', async () => {
    const here = computer({ nodeThere: false });
    const ran = here.run(['--url', ROOT, 'the-code']);
    expect(ran.code).not.toBe(0);
    expect(ran.said).toContain('the Node.js download is not the one Koala pins (its sha256 differs); nothing was installed');
    expect(existsSync(path.join(here.share, `node-v${NODE_VERSION}`))).toBe(false);
    expect(ran.handed).toBeUndefined();
  });
});
