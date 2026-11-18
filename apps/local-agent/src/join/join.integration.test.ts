import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinProgressOf, JOIN_PROGRESS_PATH, type JoinProgress } from '@koala/engine-core/machine-join';
import { localCommands } from '@koala/provision';
import { K3S_BINARY, K3S_MARKER } from '../machine-cluster.js';
import { localJoinHost } from './host.js';
import { runJoin } from './join.js';
import { K3S_CONFIG, K3S_SUDOERS } from './k3s-files.js';
import { joinPins, type JoinPins } from './pins.js';

const place = mkdtempSync(path.join(tmpdir(), 'koala-join-world-'));
const machineRoot = path.join(place, 'machine');
const home = path.join(place, 'home');
const bin = path.join(place, 'bin');
const tools = path.join(place, 'tools');
const REAL_TOOLS = ['sh', 'tar', 'gzip', 'install', 'cat', 'test', 'mkdir', 'rm', 'cp', 'chmod', 'date', 'grep', 'touch', 'env'];
const state = path.join(place, 'state');
const served = path.join(place, 'served');
const agentDir = path.join(home, '.local/share/koala/machine');
const onMachine = (file: string) => path.join(machineRoot, file);
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

const tool = (name: string, body: string) => {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
};

const heard: { auth: string | undefined; progress: JoinProgress }[] = [];
const joins: Record<string, unknown>[] = [];
let server: Server;
let url = '';
let pins: JoinPins;

const tarOf = (name: string, files: Record<string, string>): string => {
  const dir = path.join(place, `build-${name}`);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content, { mode: 0o755 });
  }
  const archive = path.join(served, name);
  execFileSync('tar', ['-czf', archive, '-C', dir, '.']);
  return archive;
};

beforeAll(async () => {
  for (const dir of [machineRoot, home, bin, tools, state, served, agentDir]) mkdirSync(dir, { recursive: true });
  for (const name of REAL_TOOLS) symlinkSync(['/usr/bin', '/bin'].map((dir) => path.join(dir, name)).find((file) => existsSync(file))!, path.join(tools, name));
  writeFileSync(path.join(agentDir, 'bundle.sha256'), `${'a'.repeat(64)}\n`);
  tool('sudo', 'case "$1" in -v|-n) exit 0 ;; --) shift ;; esac\nexec "$@"');
  tool('visudo', 'grep -q "NOPASSWD" "$2"');
  tool('loginctl', 'exit 1');
  const fakeTailscale = [
    `S='${state}'`,
    'case "$1" in',
    '  debug) if [ -f "$S/mesh" ]; then printf \'{"ControlURL":"%s","LoggedOut":false,"WantRunning":true}\' "$(cat "$S/mesh")"; else printf \'{"ControlURL":"https://controlplane.tailscale.com","LoggedOut":true,"WantRunning":false}\'; fi ;;',
    '  ip) [ -f "$S/mesh" ] && echo 100.64.0.9 || exit 1 ;;',
    '  up) for a in "$@"; do case "$a" in --login-server=*) echo "${a#--login-server=}" > "$S/mesh" ;; --auth-key=file:*) cp "${a#--auth-key=file:}" "$S/key-used" ;; esac; done; echo "Success." ;;',
    'esac',
  ].join('\n');
  tool('systemctl', [
    `S='${state}'`,
    'echo "$*" >> "$S/systemctl.log"',
    '[ "$1" = --user ] || exit 0',
    'case "$2" in',
    '  show-environment) exit 0 ;;',
    '  enable) touch "$S/enabled" ;;',
    '  restart) date +%s > "$S/active" ;;',
    '  is-enabled) [ -f "$S/enabled" ] && echo enabled || { echo disabled; exit 1; } ;;',
    '  show) if [ -f "$S/active" ]; then printf "ActiveState=active\\nActiveEnterTimestamp=@%s\\n" "$(cat "$S/active")"; else printf "ActiveState=inactive\\nActiveEnterTimestamp=\\n"; fi ;;',
    'esac',
  ].join('\n'));
  const installer = path.join(served, 'install.sh');
  writeFileSync(installer, [
    '#!/bin/sh',
    'echo "[INFO]  Skipping k3s download and verify"',
    'mkdir -p "$KOALA_MACHINE_ROOT/usr/local/bin" "$KOALA_MACHINE_ROOT/etc/systemd/system"',
    'printf "#!/bin/sh\\n" > "$KOALA_MACHINE_ROOT/usr/local/bin/k3s-killall.sh"',
    'chmod 755 "$KOALA_MACHINE_ROOT/usr/local/bin/k3s-killall.sh"',
    'echo "[Unit]" > "$KOALA_MACHINE_ROOT/etc/systemd/system/k3s.service"',
    'echo "[INFO]  systemd: Creating service file /etc/systemd/system/k3s.service"',
  ].join('\n'));
  const k3s = path.join(served, 'k3s');
  writeFileSync(k3s, 'k3s binary');
  const real = joinPins();
  const tailscale = tarOf('tailscale.tgz', {
    [`tailscale_${real.tailscale.version}_amd64/tailscale`]: `#!/bin/sh\n${fakeTailscale}\n`,
    [`tailscale_${real.tailscale.version}_amd64/tailscaled`]: '#!/bin/sh\n',
    [`tailscale_${real.tailscale.version}_amd64/systemd/tailscaled.service`]: '[Unit]\n',
    [`tailscale_${real.tailscale.version}_amd64/systemd/tailscaled.defaults`]: 'PORT=41641\n',
  });
  const helm = tarOf('helm.tgz', { 'linux-amd64/helm': `#!/bin/sh\necho ${real.helm.version}+g0000000\n` });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/machines/join') {
        const sent = JSON.parse(body) as Record<string, unknown>;
        joins.push(sent);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ env: { KOALA_ROOT_URL: url, KOALA_DEVICE_ID: `device-${joins.length}`, KOALA_DEVICE_TOKEN: `token-${joins.length}`, KOALA_ROOT_DIR: String(sent.rootDir), MESH_LOGIN_SERVER: 'https://mesh.koala.test', MESH_AUTH_KEY: 'hskey-from-root', KOALA_REGISTRY: '' } }));
        return;
      }
      if (req.method === 'POST' && req.url === JOIN_PROGRESS_PATH) {
        const read = joinProgressOf(JSON.parse(body));
        if (!read.ok) {
          res.statusCode = 400;
          res.end(read.problem);
          return;
        }
        heard.push({ auth: req.headers.authorization, progress: read.value });
        res.statusCode = 204;
        res.end();
        return;
      }
      const file = path.join(served, path.basename(req.url ?? ''));
      if (req.method === 'GET' && existsSync(file)) {
        res.end(readFileSync(file));
        return;
      }
      res.statusCode = 404;
      res.end('not here');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  pins = {
    tailscale: { ...real.tailscale, sha256: { amd64: sha(tailscale), arm64: sha(tailscale) }, url: () => `${url}/tailscale.tgz` },
    k3s: { ...real.k3s, sha256: { amd64: sha(k3s), arm64: sha(k3s) }, url: () => `${url}/k3s` },
    k3sInstaller: { sha256: sha(installer), url: `${url}/install.sh` },
    helm: { ...real.helm, sha256: { amd64: sha(helm), arm64: sha(helm) }, url: () => `${url}/helm.tgz` },
    nvidia: real.nvidia,
  };
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(place, { recursive: true, force: true });
});

async function join(code: string): Promise<{ code: number; said: string }> {
  let said = '';
  const env = { PATH: `${bin}:${path.join(machineRoot, 'usr/bin')}:${tools}`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), KOALA_MACHINE_ROOT: machineRoot };
  const exit = await runJoin(['--url', url, '--yes', code], {
    host: localJoinHost({ env, machineRoot, user: { uid: 1000, name: 'ada', group: 'ada', home }, hostname: 'desk', arch: 'x64', platform: 'linux' }),
    commands: localCommands(env),
    terminal: { write: (text) => { said += text; } },
    ask: { yesNo: async () => false, text: async (_question, offered) => offered },
    agentDir,
    node: process.execPath,
    setUpAgents: async () => undefined,
    pins: () => pins,
  });
  return { code: exit, said };
}

describe('a machine\'s join through real commands, files and HTTP, on a throwaway machine root', () => {
  it('joins, installs every stage, says each in the terminal and tells root each state', async () => {
    const first = await join('first-code');
    expect(first.code, first.said).toBe(0);
    expect(first.said).toMatch(/\[1\] Joining http:\/\/127\.0\.0\.1:\d+\n {4}this machine is desk on your account\n.*\n {2}done\n/);
    expect(first.said).toContain('[2] Installing Tailscale 1.104.1, which Koala reaches this machine through, privately\n    Tailscale 1.104.1 installed\n  done\n');
    expect(first.said).toContain('[3] Joining your private network\n    Success.\n    on the private network as 100.64.0.9\n  done\n');
    expect(first.said).toContain('[7] Installing k3s v1.36.4+k3s1, started only while there is work\n    [INFO]  Skipping k3s download and verify\n');
    expect(first.said).toContain('It runs while you are logged in. To keep it running after a restart without logging in: sudo loginctl enable-linger ada');
    expect(heard.every((entry) => entry.auth === 'Bearer first-code')).toBe(true);
    expect(heard.filter((entry) => entry.progress.state === 'done').map((entry) => entry.progress.stage)).toEqual(['join', 'tailscale', 'mesh', 'k3s-config', 'k3s-firewall', 'k3s-uninstall', 'k3s', 'k3s-sudo', 'helm', 'service']);
    expect(readFileSync(onMachine(K3S_CONFIG), 'utf8')).toContain('tls-san:\n  - 100.64.0.9\n');
    expect(readFileSync(onMachine(K3S_BINARY), 'utf8')).toBe('k3s binary');
    expect(readFileSync(onMachine(K3S_MARKER), 'utf8')).toBe('v1.36.4+k3s1\n');
    expect(statSync(onMachine(K3S_SUDOERS)).mode & 0o777).toBe(0o440);
    expect(statSync(path.join(home, '.config/koala/machine.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(state, 'key-used'), 'utf8')).toBe('hskey-from-root');
    expect(readFileSync(path.join(state, 'systemctl.log'), 'utf8')).not.toMatch(/(start|enable|restart) k3s/);
    expect(first.said).not.toContain('hskey-from-root');
    expect(JSON.stringify(heard)).not.toContain('hskey-from-root');
  });

  it('finds everything already done the next time, and replaces the machine it joined as', async () => {
    heard.length = 0;
    const again = await join('second-code');
    expect(again.code, again.said).toBe(0);
    expect(joins.map((body) => body.replaces)).toEqual(['', 'token-1']);
    expect(heard.filter((entry) => entry.progress.state !== 'started').map((entry) => `${entry.progress.stage} ${entry.progress.state}`)).toEqual([
      'join done', 'mesh already-done', 'k3s-config already-done', 'k3s-firewall already-done', 'k3s-uninstall already-done', 'k3s already-done', 'k3s-sudo already-done', 'helm already-done', 'service already-done',
    ]);
    expect(again.said.match(/already done/g)).toHaveLength(8);
  });

  it('puts back what was changed by hand, and only that', async () => {
    writeFileSync(onMachine(K3S_CONFIG), 'disable: []\n');
    heard.length = 0;
    const third = await join('third-code');
    expect(third.code, third.said).toBe(0);
    expect(heard.filter((entry) => entry.progress.state === 'done').map((entry) => entry.progress.stage)).toEqual(['join', 'k3s-config']);
    expect(readFileSync(onMachine(K3S_CONFIG), 'utf8')).toContain('tls-san:\n  - 100.64.0.9\n');
  });
});
