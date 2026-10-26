import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/root-node/ssh-over-mesh.sh', import.meta.url).pathname;
const dirs: string[] = [];

function closeSsh(sessions: string[], meshIp = '100.64.0.1', args: string[] = []) {
  const stub = mkdtempSync(join(tmpdir(), 'ssh-over-mesh-'));
  dirs.push(stub);
  const tools: Record<string, string> = {
    id: 'echo 0',
    tailscale: meshIp ? `echo ${meshIp}` : 'exit 1',
    ss: `cat "$STUB/sessions"`,
    ufw: 'echo "$*" >> "$STUB/ufw.log"',
  };
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(stub, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(stub, name), 0o755);
  }
  writeFileSync(join(stub, 'sessions'), sessions.map((line) => `${line}\n`).join(''));
  const ran = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, STUB: stub, KOALA_ETC: join(stub, 'etc') } });
  const ufw = existsSync(join(stub, 'ufw.log')) ? readFileSync(join(stub, 'ufw.log'), 'utf8').trim().split('\n') : [];
  return { code: ran.status, said: ran.stdout + ran.stderr, ufw, recorded: existsSync(join(stub, 'etc', 'ssh-over-mesh')) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('closing SSH to the internet', () => {
  it('refuses while nobody is signed in over the mesh, changing nothing', () => {
    const ran = closeSsh(['0      0      203.0.113.9:22      198.51.100.4:51000']);
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('no SSH session arrives over the mesh (at 100.64.0.1)');
    expect(ran.ufw).toEqual([]);
    expect(ran.recorded).toBe(false);
  });

  it('refuses on a host that is not on its mesh', () => {
    const ran = closeSsh([], '');
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('this host is not on its mesh');
  });

  it('opens SSH on the mesh before closing it to the internet, once someone is signed in over it, and remembers', () => {
    const ran = closeSsh(['0      0      100.64.0.1:22      100.64.0.7:51000']);
    expect(ran.code).toBe(0);
    expect(ran.ufw).toEqual(['allow in on tailscale0 to any port 22 proto tcp', 'delete allow OpenSSH']);
    expect(ran.recorded).toBe(true);
  });

  it('opens it to the internet again when asked', () => {
    const ran = closeSsh([], '100.64.0.1', ['--public']);
    expect(ran.code).toBe(0);
    expect(ran.ufw).toEqual(['allow OpenSSH']);
  });
});
