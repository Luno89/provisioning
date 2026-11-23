import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ignore } from '@koala/engine-core/failures';
import { JOIN_PROGRESS, JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { progressOf, type MachineProgress } from '@koala/engine-core/machine-progress';
import { KOALA_INSTALL_FOLLOW_PATH } from '@koala/engine-core/koala-install';
import { createServer as createSecureServer } from 'node:https';
import { localCommands, type CommandRunner, type Every, type WaitOptions } from '@koala/provision';
import { K3S_BINARY, K3S_MARKER } from '../machine-cluster.js';
import { makeCertificates } from '@koala/engine-core/testing/temporal-tls';
import { followInstall } from './follow-install.js';
import { localJoinHost, stopsOnCtrlC } from './host.js';
import { runJoin } from './join.js';
import { K3S_CONFIG, K3S_SUDOERS, NVIDIA_CDI_MARKER } from './k3s-files.js';
import { LAUNCHD_LABEL } from '../self-update.js';
import { joinPins, type JoinPins } from './pins.js';
import { OIDC_PATH } from '@koala/engine-core/root-client';
import { rootRegistration } from '../testing/root-registration.js';

const place = mkdtempSync(path.join(tmpdir(), 'koala-join-world-'));
const machineRoot = path.join(place, 'machine');
const home = path.join(place, 'home');
const bin = path.join(place, 'bin');
const tools = path.join(place, 'tools');
const REAL_TOOLS = ['sh', 'tar', 'gzip', 'install', 'cat', 'test', 'mkdir', 'rm', 'cp', 'chmod', 'date', 'grep', 'touch', 'env', 'id'];
const ENTRY = path.join(import.meta.dirname, '..', 'index.ts');
const state = path.join(place, 'state');
const served = path.join(place, 'served');
const agentDir = path.join(home, '.local/share/koala/machine');
const onMachine = (file: string) => path.join(machineRoot, file);
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

const tool = (name: string, body: string) => {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
};

const registration = rootRegistration();
const heard: { auth: string | undefined; progress: MachineProgress }[] = [];
const joins: Record<string, unknown>[] = [];
let server: Server;
let url = '';
let pins: JoinPins;
let cutReports = 0;
const followings: Array<{ events: string[]; cut?: boolean; refused?: boolean }> = [];
const followedWith: Array<string | undefined> = [];

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
  tool('sudo', `case "$1" in -v) exit 0 ;; -n) [ -f '${state}/sudo-forgets' ] && { echo "sudo: a password is required" >&2; exit 1; }; exit 0 ;; --) shift ;; esac\nexec "$@"`);
  tool('apt-get', [
    `echo "$*" >> '${state}/apt-get.log'`,
    '[ "$1" = install ] || exit 0',
    'for file in nvidia-cdi-hook nvidia-container-runtime; do printf "#!/bin/sh\\n" > "$KOALA_MACHINE_ROOT/usr/bin/$file"; chmod 755 "$KOALA_MACHINE_ROOT/usr/bin/$file"; done',
  ].join('\n'));
  tool('launchctl', [
    `S='${state}'`,
    'echo "$*" >> "$S/launchctl.log"',
    'case "$1" in',
    '  print) if [ -f "$S/launchd" ]; then printf "{\\n\\tstate = running\\n\\tpid = %s\\n}\\n" "$(cat "$S/launchd")"; else echo "Could not find service"; exit 113; fi ;;',
    '  bootout) rm -f "$S/launchd" ;;',
    '  bootstrap) echo 4242 > "$S/launchd"; LC_ALL=C date "+%a %b %e %T %Y" > "$S/launchd-started" ;;',
    'esac',
  ].join('\n'));
  tool('ps', `cat '${state}/launchd-started'`);
  tool('visudo', 'grep -q "NOPASSWD" "$2"');
  tool('loginctl', 'exit 1');
  const fakeTailscale = [
    `S='${state}'`,
    'case "$1" in',
    '  debug) [ -f "$S/tailscaled-up" ] || { touch "$S/tailscaled-up"; echo "failed to connect to local tailscaled; it doesn\'t appear to be running" >&2; exit 1; }',
    '    if [ -f "$S/mesh" ]; then printf \'{"ControlURL":"%s","LoggedOut":false,"WantRunning":true}\' "$(cat "$S/mesh")"; else printf \'{"ControlURL":"https://controlplane.tailscale.com","LoggedOut":true,"WantRunning":false}\'; fi ;;',
    '  ip) [ -f "$S/mesh" ] && echo 100.64.0.9 || exit 1 ;;',
    '  up) for a in "$@"; do case "$a" in --login-server=*) echo "${a#--login-server=}" > "$S/mesh" ;; --auth-key=file:*) cp "${a#--auth-key=file:}" "$S/key-used" ;; esac; done; echo "Success." ;;',
    'esac',
  ].join('\n');
  tool('systemctl', [
    `S='${state}'`,
    'echo "$*" >> "$S/systemctl.log"',
    '[ "$1" = is-failed ] && { echo activating; exit 1; }',
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
  const gpgkey = path.join(served, 'gpgkey');
  writeFileSync(gpgkey, '-----BEGIN PGP PUBLIC KEY BLOCK-----\nNVIDIA stand-in\n-----END PGP PUBLIC KEY BLOCK-----\n');
  const helm = tarOf('helm.tgz', { 'linux-amd64/helm': `#!/bin/sh\necho ${real.helm.version}+g0000000\n` });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (req.url?.startsWith(OIDC_PATH)) {
        const asked = new Request(`${url}${req.url}`, { method: req.method ?? 'GET', headers: req.headers as Record<string, string>, ...(req.method === 'POST' ? { body } : {}) });
        void registration.answer(asked).then(async (answer) => {
          res.writeHead(answer?.status ?? 404, { 'content-type': 'application/json' });
          res.end(answer ? await answer.text() : 'not here');
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/machines/join') {
        const sent = JSON.parse(body) as Record<string, unknown>;
        joins.push(sent);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ env: { KOALA_ROOT_URL: url, KOALA_DEVICE_ID: `device-${joins.length}`, KOALA_REGISTRATION_TOKEN: registration.codeFor(`device-${joins.length}`), KOALA_ROOT_DIR: String(sent.rootDir), MESH_LOGIN_SERVER: 'https://mesh.koala.test', MESH_AUTH_KEY: 'hskey-from-root', KOALA_REGISTRY: '' } }));
        return;
      }
      if (req.method === 'POST' && req.url === JOIN_PROGRESS_PATH) {
        if (cutReports > 0) {
          cutReports -= 1;
          req.socket.destroy();
          return;
        }
        const read = progressOf(JSON.parse(body), JOIN_PROGRESS);
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
      if (req.method === 'GET' && req.url === KOALA_INSTALL_FOLLOW_PATH) {
        followedWith.push(req.headers.authorization);
        const answer = followings.shift();
        if (!answer) {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (answer.refused) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of answer.events) res.write(event);
        if (answer.cut) res.write('', () => { res.socket?.destroy(); });
        else res.end();
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
    nvidia: { ...real.nvidia, keySha256: sha(gpgkey), repo: url },
  };
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(place, { recursive: true, force: true });
});

const machineEnv = () => ({ PATH: `${bin}:${path.join(machineRoot, 'usr/bin')}:${tools}`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), KOALA_MACHINE_ROOT: machineRoot });

interface JoinWorld { platform?: NodeJS.Platform; every?: Every; commands?: (real: CommandRunner) => CommandRunner; setUpAgents?: () => Promise<void>; followWait?: WaitOptions }

async function join(code: string, world: JoinWorld = {}): Promise<{ code: number; said: string }> {
  let said = '';
  const env = machineEnv();
  const exit = await runJoin(['--url', url, '--yes', code], {
    host: localJoinHost({ env, machineRoot, user: { uid: 1000, name: 'ada', group: 'ada', home }, hostname: 'desk', arch: 'x64', platform: world.platform ?? 'linux' }),
    commands: (world.commands ?? ((real) => real))(localCommands(env)),
    terminal: { write: (text) => { said += text; } },
    ask: { yesNo: async () => false, text: async (_question, offered) => offered },
    agentDir,
    node: process.execPath,
    setUpAgents: () => world.setUpAgents?.() ?? Promise.resolve(),
    pins: () => pins,
    onInterrupt: stopsOnCtrlC,
    ...(world.every ? { every: world.every } : {}),
    ...(world.followWait ? { followWait: world.followWait } : {}),
  });
  return { code: exit, said };
}

async function agentJoin(args: string[], env: Record<string, string>): Promise<{ code: number | null; said: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'join', '--url', url, ...args], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: {
      ...env,
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  child.stdout.on('data', (chunk: Buffer) => { said += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString(); });
  const code = await new Promise<number | null>((done) => child.once('close', (exit) => done(exit)));
  return { code, said };
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
    expect(joins.map((body) => body.replaces)).toEqual(['', 'token-for-device-1']);
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

  it('goes on telling root each stage when a report is cut off on the way', async () => {
    heard.length = 0;
    cutReports = 1;
    const fourth = await join('fourth-code');
    expect(fourth.code, fourth.said).toBe(0);
    expect(heard.slice(0, 2).map((entry) => `${entry.progress.stage} ${entry.progress.state}`)).toEqual(['join started', 'join done']);
  });

  it('stops at the join, saying where, why and what to do, and makes no machine, when the settings it kept are not the ones Koala writes', async () => {
    const settings = path.join(home, '.config/koala/machine.json');
    const kept = readFileSync(settings, 'utf8');
    const made = joins.length;
    heard.length = 0;
    writeFileSync(settings, 'not what Koala writes');
    const fifth = await join('fifth-code');
    writeFileSync(settings, kept);
    expect(fifth.code, fifth.said).toBe(1);
    expect(fifth.said).toContain(`failed: ${settings} is not the settings Koala writes (`);
    expect(fifth.said).toContain(`If this machine is on My Machines already, remove it there; then delete ${settings} and run this command again.`);
    expect(joins).toHaveLength(made);
    const failed = heard.find((entry) => entry.progress.state === 'failed');
    expect(failed?.progress).toMatchObject({ stage: 'join', state: 'failed' });
    expect(failed?.progress.why).toContain(`${settings} is not the settings Koala writes (`);
  });

  it('tells the person when sudo stops keeping their password partway through', async () => {
    let refresh: (() => void) | undefined;
    let refreshed: Promise<unknown> | undefined;
    writeFileSync(path.join(state, 'sudo-forgets'), '');
    const sixth = await join('sixth-code', {
      every: (given) => { refresh = given; return { stop: () => undefined }; },
      commands: (real) => ({
        run: (command, progress) => {
          const ran = real.run(command, progress);
          if (command.command === 'sudo' && command.args?.[0] === '-n') refreshed = ran;
          return ran;
        },
      }),
      setUpAgents: async () => {
        refresh?.();
        await refreshed?.catch(ignore('sudo refusing to keep the password is what this run is about; its end is all that is waited for'));
      },
    });
    rmSync(path.join(state, 'sudo-forgets'));
    expect(sixth.code, sixth.said).toBe(0);
    expect(sixth.said).toContain('  sudo no longer keeps your password, so it may ask again: ');
  });

  it('installs NVIDIA\'s CDI support from NVIDIA\'s own repository when the machine has an NVIDIA GPU', async () => {
    tool('nvidia-smi', 'echo "GPU 0: NVIDIA GeForce RTX 4090"');
    writeFileSync(onMachine('/etc/os-release'), 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n');
    heard.length = 0;
    const gpu = await join('gpu-code');
    expect(gpu.code, gpu.said).toBe(0);
    expect(gpu.said).toContain(`NVIDIA's CDI support ${pins.nvidia.version} installed from NVIDIA's own repository; apps here can be given this machine's NVIDIA GPUs`);
    expect(heard.filter((entry) => entry.progress.state === 'done').map((entry) => entry.progress.stage)).toEqual(['join', 'nvidia-cdi']);
    expect(readFileSync(onMachine('/etc/apt/sources.list.d/koala-nvidia-container-toolkit.list'), 'utf8')).toBe(`deb [signed-by=/usr/share/keyrings/koala-nvidia-container-toolkit.asc] ${url}/stable/deb/$(ARCH) /\n`);
    expect(readFileSync(onMachine('/usr/share/keyrings/koala-nvidia-container-toolkit.asc'), 'utf8')).toContain('NVIDIA stand-in');
    expect(readFileSync(path.join(state, 'apt-get.log'), 'utf8')).toContain(`install -y nvidia-container-toolkit=${pins.nvidia.version}`);
    expect(readFileSync(onMachine(NVIDIA_CDI_MARKER), 'utf8')).toBe('apt\n');
  });

  it('starts the agent under launchd on a Mac, and restarts it when its plist was changed by hand', async () => {
    const plist = path.join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const target = 'gui/1000';
    heard.length = 0;
    const mac = await join('mac-code', { platform: 'darwin' });
    expect(mac.code, mac.said).toBe(0);
    expect(heard.filter((entry) => entry.progress.state === 'done').map((entry) => entry.progress.stage)).toEqual(['join', 'service']);
    expect(mac.said).toContain(`running as ${LAUNCHD_LABEL} (its log is ~/Library/Logs/koala-machine.log)`);
    expect(readFileSync(plist, 'utf8')).toContain(`<string>${path.join(agentDir, 'agent.mjs')}</string>`);
    expect(existsSync(path.join(home, 'Library/Logs'))).toBe(true);

    writeFileSync(plist, 'changed by hand');
    rmSync(path.join(state, 'launchctl.log'));
    heard.length = 0;
    const again = await join('mac-code-again', { platform: 'darwin' });
    expect(again.code, again.said).toBe(0);
    expect(heard.filter((entry) => entry.progress.state === 'done').map((entry) => entry.progress.stage)).toEqual(['join', 'service']);
    expect(readFileSync(path.join(state, 'launchctl.log'), 'utf8').trim().split('\n').filter((line) => !line.startsWith('print'))).toEqual([`bootout ${target} ${plist}`, `bootstrap ${target} ${plist}`]);
    expect(readFileSync(plist, 'utf8')).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
  });

  it('joins from the agent program itself, working in the folder it offers when there is no terminal to ask on', async () => {
    heard.length = 0;
    const ran = await agentJoin(['--no-cluster', '--no-service', '--adapters', 'none', 'program-code'], machineEnv());
    expect(ran.code, ran.said).toBe(0);
    expect(ran.said).toContain(`Koala works in ${path.join(home, 'koala')}, and nowhere else`);
    expect(ran.said).toContain('No coding agents were found yet.');
    expect(ran.said).toContain(`Start it with\n  ${process.execPath} ${path.join(import.meta.dirname, '..', 'agent.mjs')}\n`);
    expect(heard.filter((entry) => entry.progress.state !== 'started').map((entry) => `${entry.progress.stage} ${entry.progress.state}`)).toEqual(['join done', 'mesh already-done', 'helm already-done']);
    expect(heard.every((entry) => entry.auth === 'Bearer program-code')).toBe(true);
  });

  it('installs nothing and says why when it cannot ask on a terminal whether to install Tailscale', async () => {
    heard.length = 0;
    const before = joins.length;
    const ran = await agentJoin(['--no-service', '--adapters', 'none', 'no-terminal-code'], { ...machineEnv(), PATH: `${bin}:${tools}` });
    expect(ran.code, ran.said).toBe(1);
    expect(ran.said).toContain('  stopped: this machine needs the private network to take work\n');
    expect(joins.length).toBe(before);
    expect(heard).toEqual([]);
  });

  it('refuses to start as a service an agent the command from My Machines did not install, and says so', async () => {
    heard.length = 0;
    const ran = await agentJoin(['--no-cluster', '--adapters', 'none', 'unbundled-code'], machineEnv());
    const why = `${path.join(import.meta.dirname, '..', 'bundle.sha256')} is not there, so this agent was not installed by the command from My Machines: run that command`;
    expect(ran.code, ran.said).toBe(1);
    expect(ran.said).toContain(why);
    expect(heard.at(-1)?.progress).toEqual({ stage: 'service', title: 'Starting the machine agent, now and whenever you log in', state: 'failed', why: `its check failed after applying: ${why}` });
  });

  it('follows root putting Koala on the machine over real HTTP, again after the connection is cut, to ready, and to failed', async () => {
    const event = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;
    const install = (state: string, more: Record<string, string> = {}) => ({ id: 'install-1', machineId: 'device-1', state, at: '2026-11-18T10:00:00.000Z', ...more });
    const chart = event({ install: install('installing', { stage: 'chart', title: 'Installing Koala\'s chart', line: 'waiting for deployment/koala' }) });
    followedWith.length = 0;
    followings.push({ events: [': beat\n\n', chart], cut: true }, { events: [chart, event({ install: install('ready', { stage: 'koala', title: 'Koala' }), url: 'https://bobby.koala.app' })] });
    const ready = await join('koala-code');
    expect(ready.code, ready.said).toBe(0);
    expect(followedWith).toHaveLength(2);
    expect(new Set(followedWith).size).toBe(1);
    expect(followedWith[0]).toBe(`Bearer token-for-${(JSON.parse(readFileSync(path.join(home, '.config/koala/machine.json'), 'utf8')) as { deviceId: string }).deviceId}`);
    expect(ready.said.match(/waiting for deployment\/koala/g)).toHaveLength(1);
    expect(ready.said).toMatch(/The connection to root dropped \(.+\); following again/);
    expect(ready.said.trimEnd().endsWith('Koala is ready at https://bobby.koala.app')).toBe(true);

    followings.push({ events: [event({ install: install('failed', { stage: 'chart', title: 'Installing Koala\'s chart', why: 'the image could not be pulled' }) })] });
    const failed = await join('koala-code-again');
    expect(failed.code, failed.said).toBe(1);
    expect(failed.said.trimEnd().endsWith('Putting Koala on this machine stopped at Installing Koala\'s chart: the image could not be pulled')).toBe(true);
  });

  it('tells the person root cannot be reached yet while root drops the follow before answering, and follows on to ready once it answers', async () => {
    const event = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;
    followedWith.length = 0;
    followings.push({ events: [], refused: true }, { events: [event({ install: { id: 'install-2', machineId: 'device-1', state: 'ready', at: '2026-11-18T11:00:00.000Z', stage: 'koala', title: 'Koala' }, url: 'https://bobby.koala.app' })] });
    const ready = await join('koala-code-dropped', { followWait: { pause: async () => undefined, sayEvery: 1 } });
    expect(ready.code, ready.said).toBe(0);
    expect(followedWith).toHaveLength(2);
    expect(ready.said).toMatch(/ {2}root cannot be reached yet \(.+\); following again\n/);
    expect(ready.said.trimEnd().endsWith('Koala is ready at https://bobby.koala.app')).toBe(true);
  });

  it('stops following, saying why, when root answers with a certificate this machine does not trust', async () => {
    const certificates = makeCertificates();
    const secure = createSecureServer({ cert: certificates.cert, key: certificates.key }, (_req, res) => { res.end(); });
    await new Promise<void>((done) => secure.listen(0, '127.0.0.1', done));
    try {
      const said: string[] = [];
      const following = followInstall({
        rootUrl: `https://127.0.0.1:${(secure.address() as { port: number }).port}`, token: async () => 'token-1', fetch, say: (line) => { said.push(line); }, section: () => undefined,
        interrupted: new AbortController().signal, wait: { pause: async () => { throw new Error('the follow was tried again after root\'s certificate was refused, which no later try can change'); } },
      });
      await expect(following).rejects.toThrow(/^root could not be asked how putting Koala on this machine goes: .+/);
      expect(said).toEqual([]);
    } finally {
      await new Promise((done) => secure.close(done));
    }
  });
});
