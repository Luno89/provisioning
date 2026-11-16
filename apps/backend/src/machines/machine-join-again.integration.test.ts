import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnScript } from '../../../../tests/coupling/shell-trace.js';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const JOIN = path.join(REPO, 'scripts/machine/machine.sh');
const NODE_VERSION = /^NODE_VERSION=(\S+)$/m.exec(readFileSync(JOIN, 'utf8'))![1]!;

function computer() {
  const home = mkdtempSync(path.join(tmpdir(), 'koala-join-again-'));
  const bin = path.join(home, 'bin');
  const nodeDir = path.join(home, '.local/share/koala', `node-v${NODE_VERSION}`, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(nodeDir, { recursive: true });
  symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  const sent = path.join(home, 'sent.log');
  const tool = (name: string, body: string) => { writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  let device = 0;
  const join = () => {
    device += 1;
    const reply = JSON.stringify({ env: { KOALA_ROOT_URL: 'http://root.test', KOALA_DEVICE_ID: `device-${device}`, KOALA_DEVICE_TOKEN: `token-${device}`, KOALA_ROOT_DIR: path.join(home, 'koala'), MESH_LOGIN_SERVER: 'http://mesh.test', MESH_AUTH_KEY: 'mesh-key' } });
    writeFileSync(path.join(home, 'reply.json'), reply);
    tool('curl', `out=""\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\ncat >> '${sent}'\necho >> '${sent}'\ncp '${path.join(home, 'reply.json')}' "$out"\nprintf 200`);
    tool('tailscale', 'exit 0');
    tool('sudo', 'echo "sudo: a password is required" >&2\nexit 1');
    const run = spawnScript(JOIN, ['--yes', '--url', 'http://root.test', '--folder', path.join(home, 'koala'), 'the-code'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') },
    });
    return { code: run.status, said: `${run.stdout}${run.stderr}` };
  };
  const machineFile = path.join(home, '.config/koala/machine.json');
  return { join, machineFile, sent: () => readFileSync(sent, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { replaces: string }) };
}

describe('a join that stops after root has made the machine', () => {
  it('keeps the machine\'s token, so running the command again replaces that machine rather than adding a second', () => {
    const here = computer();
    const first = here.join();
    expect(first.code, first.said).not.toBe(0);
    expect(first.said).toMatch(/sudo: a password is required/);
    expect(JSON.parse(readFileSync(here.machineFile, 'utf8'))).toEqual({ rootUrl: 'http://root.test', token: 'token-1', deviceId: 'device-1', rootDir: expect.stringMatching(/\/koala$/) as unknown });
    expect(statSync(here.machineFile).mode & 0o777).toBe(0o600);

    here.join();
    expect(here.sent().map((body) => body.replaces)).toEqual(['', 'token-1']);
  });
});
