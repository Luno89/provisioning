import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/root-node/join-mesh.sh', import.meta.url).pathname;
const SERVER = 'https://mesh.koala.test';
const dirs: string[] = [];

const TAILSCALE = `#!/usr/bin/env bash
case "$1" in
  ip) [ -f "$STUB/joined" ] && echo 100.64.0.1 ;;
  up) echo $$ > "$STUB/up.pid"; exec bash "$STUB/up" ;;
esac
`;
const JOURNALCTL = `#!/usr/bin/env bash
cat "$STUB/journal"
`;

function joinMesh(up: string, journal: string[] = []) {
  const stub = mkdtempSync(join(tmpdir(), 'join-mesh-'));
  dirs.push(stub);
  writeFileSync(join(stub, 'tailscale'), TAILSCALE);
  writeFileSync(join(stub, 'journalctl'), JOURNALCTL);
  chmodSync(join(stub, 'tailscale'), 0o755);
  chmodSync(join(stub, 'journalctl'), 0o755);
  writeFileSync(join(stub, 'up'), up);
  writeFileSync(join(stub, 'journal'), journal.map((line) => `${line}\n`).join(''));
  const ran = spawnSync('bash', [SCRIPT, SERVER, 'nowrinkles-root'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, STUB: stub, MESH_AUTHKEY: 'hskey-test' },
  });
  let upAlive = existsSync(join(stub, 'up.pid'));
  if (upAlive) try { process.kill(Number(readFileSync(join(stub, 'up.pid'), 'utf8')), 0); } catch { upAlive = false; }
  return { code: ran.status, out: ran.stdout.trim(), err: ran.stderr, upAlive };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('root joining its own mesh', () => {
  it('prints the mesh address once Tailscale has joined', () => {
    const ran = joinMesh('sleep 1; touch "$STUB/joined"');
    expect(ran.code).toBe(0);
    expect(ran.out).toBe('100.64.0.1');
  });

  it('stops with Tailscale\'s error when the mesh server\'s certificate is not trusted', () => {
    const ran = joinMesh('exec sleep 1000', [
      'control: doLogin(regen=true, hasUrl=false)',
      `Received error: fetch control key: Get "${SERVER}/key?v=148": x509: certificate signed by unknown authority`,
    ]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`Tailscale cannot join ${SERVER}: fetch control key: Get "${SERVER}/key?v=148": x509: certificate signed by unknown authority`);
    expect(ran.upAlive).toBe(false);
  });

  it('stops with what tailscale up said when it gives up', () => {
    const ran = joinMesh('echo "backend error: invalid key: unable to validate API key" >&2; exit 1');
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('tailscale up failed: backend error: invalid key: unable to validate API key');
  });

  it('keeps waiting through an error that can pass, saying it once', () => {
    const ran = joinMesh('sleep 1; touch "$STUB/joined"', [
      `Received error: fetch control key: Get "${SERVER}/key?v=148": dial tcp 10.0.0.1:443: connect: connection refused`,
    ]);
    expect(ran.code).toBe(0);
    expect(ran.out).toBe('100.64.0.1');
    expect(ran.err.match(/still trying/g)).toHaveLength(1);
  });
});
