import { describe, expect, it } from 'vitest';
import { memoryReporter, type MemoryReporter } from '@koala/provision/testing';
import { K3S_BINARY, K3S_MARKER, K3S_UNINSTALL } from '../machine-cluster.js';
import { AGENT_DIR, archive, HOME, joinWorld, NODE, type World, type WorldOptions } from '../testing/join-world.js';
import { runJoin, type JoinDeps } from './join.js';
import { K3S_CONFIG, K3S_FIREWALL, K3S_NODE_PORTS_FILE, K3S_REGISTRIES, K3S_SUDOERS, MACHINE_UNINSTALL_SCRIPT } from './k3s-files.js';
import { joinPins } from './pins.js';

const pins = joinPins();
const DOWNLOADS: Record<string, string> = {
  [pins.tailscale.url('amd64')]: archive({ [`tailscale_${pins.tailscale.version}_amd64/tailscale`]: 'ts', [`tailscale_${pins.tailscale.version}_amd64/tailscaled`]: 'tsd', [`tailscale_${pins.tailscale.version}_amd64/systemd/tailscaled.service`]: '[Unit]', [`tailscale_${pins.tailscale.version}_amd64/systemd/tailscaled.defaults`]: 'PORT=41641' }),
  [pins.k3sInstaller.url]: '#!/bin/sh\necho the k3s installer\n',
  [pins.k3s.url('amd64')]: 'k3s binary',
  [pins.helm.url('amd64')]: archive({ 'linux-amd64/helm': `${pins.helm.version}+g7bf0dd5` }),
  [`${pins.nvidia.repo}/gpgkey`]: '-----BEGIN PGP PUBLIC KEY BLOCK-----',
};

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n';

interface Ran { code: number; said: string; root: MemoryReporter; asked: string[]; agents: string[] }

const machine = (options: WorldOptions = {}): World => joinWorld({
  downloads: DOWNLOADS,
  ...options,
  files: { [`${AGENT_DIR}/bundle.sha256`]: `${'a'.repeat(64)}\n`, ...options.files },
});

async function join(world: World, argv: string[], answers: Record<string, boolean> = {}, more: Partial<JoinDeps> = {}): Promise<Ran> {
  let said = '';
  const root = memoryReporter();
  const asked: string[] = [];
  const agents: string[] = [];
  world.tick();
  const code = await runJoin(['--url', 'https://root.test', ...argv], {
    host: world.host,
    commands: world.commands,
    terminal: { write: (text) => { said += text; } },
    ask: {
      yesNo: async (question) => {
        asked.push(question);
        return Object.entries(answers).find(([start]) => question.startsWith(start))?.[1] ?? false;
      },
      text: async (question, offered) => {
        asked.push(question);
        return offered;
      },
    },
    agentDir: AGENT_DIR,
    node: NODE,
    setUpAgents: async (choice, folder) => { agents.push(`${choice} in ${folder}`); },
    rootReporter: () => root,
    every: () => ({ stop: () => undefined }),
    followWait: { pause: async () => undefined },
    ...more,
  });
  world.tick();
  return { code, said, root, asked, agents };
}

const statesOf = (root: MemoryReporter): string[] => root.reported.filter((entry) => entry.kind !== 'line').map((entry) => `${entry.id} ${entry.kind}`);

describe('joining a fresh Linux machine with --yes', () => {
  it('joins root, the private network and installs k3s stopped, helm and the service, asking nothing, telling root each stage', async () => {
    const world = machine({ files: { '/etc/os-release': UBUNTU }, executables: ['/usr/bin/systemctl'] });
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code, ran.said).toBe(0);
    expect(ran.asked).toEqual([]);
    expect(statesOf(ran.root)).toEqual([
      'join started', 'join done',
      'tailscale started', 'tailscale done',
      'mesh started', 'mesh done',
      'k3s-config started', 'k3s-config done',
      'k3s-firewall started', 'k3s-firewall done',
      'k3s-uninstall started', 'k3s-uninstall done',
      'k3s started', 'k3s done',
      'k3s-sudo started', 'k3s-sudo done',
      'helm started', 'helm done',
      'service started', 'service done',
    ]);
    expect(world.joins).toEqual([{ code: 'the-code', hostname: 'desk', rootDir: `${HOME}/koala`, os: 'Linux x86_64', replaces: '' }]);
    expect(JSON.parse(world.files.get(`${HOME}/.config/koala/machine.json`)!)).toEqual({ rootUrl: 'https://root.test', token: 'token-1', deviceId: 'device-1', rootDir: `${HOME}/koala` });
    expect(world.modes.get(`${HOME}/.config/koala/machine.json`)).toBe(0o600);
    expect(world.files.get(K3S_CONFIG)).toBe('disable:\n  - traefik\n  - servicelb\ntls-san:\n  - 100.64.0.7\nwrite-kubeconfig-mode: "0640"\nwrite-kubeconfig-group: ada\n');
    expect(world.files.get(K3S_NODE_PORTS_FILE)).toContain('nodeport-addresses=127.0.0.1/32,100.64.0.0/10');
    expect(world.files.get(K3S_REGISTRIES)).toBe('mirrors:\n  "registry.root.test:5000":\n    endpoint:\n      - "http://registry.root.test:5000"\n');
    expect(world.files.get(K3S_UNINSTALL)).toBe(MACHINE_UNINSTALL_SCRIPT);
    expect(world.executables.has(K3S_FIREWALL)).toBe(true);
    expect(world.files.get(K3S_MARKER)).toBe(`${pins.k3s.version}\n`);
    expect(world.files.get(K3S_BINARY)).toBe('k3s binary');
    expect(world.files.get(K3S_SUDOERS)).toBe('ada ALL=(root) NOPASSWD: /usr/bin/systemctl start k3s, /usr/bin/systemctl stop k3s, /usr/local/bin/k3s-killall.sh, /usr/local/lib/koala/machine-uninstall.sh\n');
    expect(world.modes.get(K3S_SUDOERS)).toBe(0o440);
    expect(world.files.get(`${HOME}/.local/share/koala/bin/helm`)).toBe(`${pins.helm.version}+g7bf0dd5`);
    expect(world.files.get(`${HOME}/.config/systemd/user/koala-machine.service`)).toContain(`ExecStart=${NODE} ${AGENT_DIR}/agent.mjs\nWorkingDirectory=${HOME}/koala\n`);
    expect(ran.agents).toEqual([`all in ${HOME}/koala`]);
    expect(ran.said).toContain('This machine shows on My Machines in a moment');
  });

  it('asks sudo for the password once, and starts k3s never', async () => {
    const world = machine({ files: { '/etc/os-release': UBUNTU }, executables: ['/usr/bin/systemctl'] });
    await join(world, ['--yes', 'the-code']);
    expect(world.ran().filter((line) => line.startsWith('sudo -v'))).toHaveLength(1);
    expect(world.ran().some((line) => /systemctl (enable|start|restart).*k3s/.test(line))).toBe(false);
    expect(world.sudo()).toContainEqual(expect.stringMatching(/^sh \/tmp\/koala-join-\d+\/install\.sh$/));
  });

  it('joins the private network with the key in a file only the person reads, never on the command line', async () => {
    const world = machine({ executables: ['/usr/bin/systemctl'] });
    const ran = await join(world, ['--yes', '--no-cluster', 'the-code']);
    const up = world.sudo().find((line) => line.startsWith('tailscale up'))!;
    expect(up).toMatch(/^tailscale up --login-server=https:\/\/mesh\.root\.test --auth-key=file:\/tmp\/koala-join-\d+\/mesh-key --accept-dns=false$/);
    expect(world.ran().join('\n')).not.toContain('hskey-the-mesh-key');
    expect(ran.said).not.toContain('hskey-the-mesh-key');
    expect([...world.files.keys()].some((file) => file.endsWith('/mesh-key'))).toBe(false);
    expect(ran.said).toContain('on the private network as 100.64.0.7');
  });
});

describe('running the command again', () => {
  it('replaces the machine it joined as, and finds every stage after the join already done', async () => {
    const world = machine({ files: { '/etc/os-release': UBUNTU }, executables: ['/usr/bin/systemctl'] });
    await join(world, ['--yes', 'first-code']);
    const sudoBefore = world.sudo().length;
    const again = await join(world, ['--yes', 'second-code']);
    expect(again.code, again.said).toBe(0);
    expect(world.joins.map((body) => body.replaces)).toEqual(['', 'token-1']);
    expect(statesOf(again.root).filter((state) => !state.endsWith('started'))).toEqual([
      'join done', 'mesh already-done', 'k3s-config already-done', 'k3s-firewall already-done', 'k3s-uninstall already-done',
      'k3s already-done', 'k3s-sudo already-done', 'helm already-done', 'service already-done',
    ]);
    expect(world.sudo().slice(sudoBefore).filter((line) => !/^(test|cat) /.test(line))).toEqual([]);
  });

  it('restarts the service when machine.sh installed a newer agent since it started', async () => {
    const world = machine({ executables: ['/usr/bin/systemctl'] });
    await join(world, ['--yes', '--no-cluster', 'first-code']);
    world.tick();
    world.files.set(`${AGENT_DIR}/bundle.sha256`, `${'b'.repeat(64)}\n`);
    await world.host.writeOwn(`${AGENT_DIR}/bundle.sha256`, `${'b'.repeat(64)}\n`, 0o644);
    const again = await join(world, ['--yes', '--no-cluster', 'second-code']);
    expect(statesOf(again.root)).toContain('service done');
    expect(again.root.reported).toContainEqual({ kind: 'line', id: 'service', text: 'running as the koala-machine service (journalctl --user -u koala-machine to read it)' });
  });

  it('keeps the token of a join that stopped after root made the machine, so the next run replaces it', async () => {
    const world = machine({ refuse: (command) => (command.command === 'sudo' && command.args?.[0] === '-v' ? { code: 1, stderr: 'sudo: a password is required' } : undefined) });
    const first = await join(world, ['--yes', 'first-code']);
    expect(first.code).toBe(1);
    expect(first.said).toContain('failed: sudo did not let this run as root');
    expect(JSON.parse(world.files.get(`${HOME}/.config/koala/machine.json`)!)).toMatchObject({ token: 'token-1', deviceId: 'device-1' });
    await join(world, ['--yes', 'second-code']);
    expect(world.joins.map((body) => body.replaces)).toEqual(['', 'token-1']);
  });
});

describe('a machine with k3s of the person\'s own', () => {
  it('leaves it alone: no question, nothing of k3s installed or changed, no helm', async () => {
    const world = machine({ executables: [K3S_BINARY, '/usr/bin/systemctl', '/usr/bin/nvidia-smi'], files: { '/etc/os-release': UBUNTU } });
    const ran = await join(world, ['the-code'], { 'Tailscale': true });
    expect(ran.code, ran.said).toBe(0);
    expect(ran.said).toContain('this machine already runs k3s of its own; Koala leaves it alone and runs no apps here');
    expect(ran.asked.filter((question) => /k3s|NVIDIA/.test(question))).toEqual([]);
    expect(statesOf(ran.root).map((state) => state.split(' ')[0])).not.toContain('k3s');
    expect(world.sudo().filter((line) => /k3s|rancher|sudoers/.test(line))).toEqual([]);
    expect(world.files.has(K3S_MARKER)).toBe(false);
    expect(statesOf(ran.root).some((state) => state.startsWith('helm'))).toBe(false);
  });
});

describe('asking the person', () => {
  it('asks y/N for each install, and the folder, unless --yes', async () => {
    const world = machine({ executables: ['/usr/bin/systemctl', '/usr/bin/nvidia-smi'], files: { '/etc/os-release': UBUNTU } });
    const ran = await join(world, ['the-code'], { 'Tailscale': true, 'Koala runs apps': true, 'This machine has an NVIDIA GPU': true });
    expect(ran.asked).toEqual([
      'Which folder may Koala work in?',
      'Tailscale isn\'t installed. Koala reaches this machine through it, privately. Install it?',
      `Koala runs apps and workspaces here in k3s, started only while there is work and stopped after. Install k3s ${pins.k3s.version} (asks for sudo once)?`,
      `This machine has an NVIDIA GPU. Install NVIDIA's CDI support (nvidia-container-toolkit ${pins.nvidia.version}, from NVIDIA's own repository) so apps here can use it?`,
    ]);
    expect(ran.agents).toEqual([`ask in ${HOME}/koala`]);
  });

  it('stops before joining root when the person declines Tailscale, which the machine takes work over', async () => {
    const world = machine();
    const ran = await join(world, ['the-code'], {});
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('stopped: this machine needs the private network to take work');
    expect(world.joins).toEqual([]);
    expect(ran.root.reported).toEqual([]);
  });

  it('runs only the coding agents when the person declines k3s, saying how to add it later', async () => {
    const world = machine({ tailscale: { installed: true }, executables: ['/usr/bin/systemctl'] });
    const ran = await join(world, ['the-code'], {});
    expect(ran.code, ran.said).toBe(0);
    expect(ran.said).toContain('without it Koala runs only your coding agents here; run this command again to add it');
    expect(world.files.has(K3S_MARKER)).toBe(false);
  });

  it('works only in a folder of its own', async () => {
    const ran = await join(machine(), ['--yes', '--folder', HOME, 'the-code']);
    expect(ran.code).toBe(1);
    expect(ran.said).toContain(`Koala works in a folder of its own, never ${HOME}`);
  });

  it('refuses to run as root, since the agents it finds are the person\'s', async () => {
    const ran = await join(machine({ uid: 0 }), ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('run this as yourself, not root: the agents it finds are yours');
  });
});

describe('NVIDIA\'s CDI support on a machine with an NVIDIA GPU', () => {
  const gpu = (osRelease: string, extra: Partial<WorldOptions> = {}) => machine({ executables: ['/usr/bin/systemctl', '/usr/bin/nvidia-smi', ...(extra.executables ?? [])], files: { '/etc/os-release': osRelease }, ...(extra.refuse ? { refuse: extra.refuse } : {}), ...(extra.downloads ? { downloads: extra.downloads } : {}) });

  it('on Debian or Ubuntu, adds NVIDIA\'s own repository under the pinned key and installs the pinned packages, then keeps its CDI spec fresh', async () => {
    const world = gpu(UBUNTU);
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code, ran.said).toBe(0);
    const cdi = world.sudo().slice(world.sudo().findIndex((line) => line.includes('koala-nvidia-container-toolkit.asc')));
    expect(cdi.slice(0, 7)).toEqual([
      expect.stringMatching(/^install -D -m 644 \S+\/gpgkey \/usr\/share\/keyrings\/koala-nvidia-container-toolkit\.asc$/) as unknown,
      expect.stringMatching(/^install -D -m 644 \S+ \/etc\/apt\/sources\.list\.d\/koala-nvidia-container-toolkit\.list$/) as unknown,
      'apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/koala-nvidia-container-toolkit.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0',
      'apt-get install -y nvidia-container-toolkit=1.20.1-1 nvidia-container-toolkit-base=1.20.1-1 libnvidia-container-tools=1.20.1-1 libnvidia-container1=1.20.1-1',
      'systemctl enable --now nvidia-cdi-refresh.path',
      'systemctl start nvidia-cdi-refresh.service',
      expect.stringMatching(/^install -D -m 644 \S+ \/etc\/koala\/nvidia-cdi$/) as unknown,
    ]);
    expect(world.files.get('/etc/apt/sources.list.d/koala-nvidia-container-toolkit.list')).toBe('deb [signed-by=/usr/share/keyrings/koala-nvidia-container-toolkit.asc] https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /\n');
    expect(world.files.get('/etc/koala/nvidia-cdi')).toBe('apt\n');
  });

  it('on Fedora or RHEL, adds NVIDIA\'s own repository with the pinned key and installs the pinned packages', async () => {
    const world = gpu('ID=fedora\n');
    await join(world, ['--yes', 'the-code']);
    expect(world.files.get('/etc/yum.repos.d/koala-nvidia-container-toolkit.repo')).toBe('[koala-nvidia-container-toolkit]\nname=NVIDIA Container Toolkit, added by Koala\nbaseurl=https://nvidia.github.io/libnvidia-container/stable/rpm/$basearch\nrepo_gpgcheck=1\ngpgcheck=0\nenabled=1\ngpgkey=file:///etc/pki/rpm-gpg/KOALA-NVIDIA-CONTAINER-TOOLKIT\n');
    expect(world.sudo()).toContain('dnf install -y nvidia-container-toolkit-1.20.1-1 nvidia-container-toolkit-base-1.20.1-1 libnvidia-container-tools-1.20.1-1 libnvidia-container1-1.20.1-1');
    expect(world.files.get('/etc/koala/nvidia-cdi')).toBe('dnf\n');
  });

  it('installs nothing, saying so, when the key it downloads is not the one Koala pins', async () => {
    const world = gpu(UBUNTU, { downloads: { ...DOWNLOADS, [`${pins.nvidia.repo}/gpgkey`]: 'tampered' } });
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('failed: NVIDIA\'s package signing key from https://nvidia.github.io/libnvidia-container/gpgkey is not the one Koala pins (its sha256 differs); nothing was installed');
    expect(world.sudo().some((line) => line.includes('nvidia'))).toBe(false);
    expect(ran.root.reported.at(-1)).toMatchObject({ kind: 'failed', id: 'nvidia-cdi', why: expect.stringContaining('is not the one Koala pins') as unknown });
  });

  it('says how to install it by hand, and installs nothing, on a system NVIDIA\'s repository does not serve', async () => {
    const world = gpu('ID=arch\n');
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.said).toMatch(/NVIDIA's CDI support is not offered on this system, so its GPUs are not used\. Install nvidia-container-toolkit 1\.20\.1-1 as https:\/\/docs\.nvidia\.com\/.+ says, enable nvidia-cdi-refresh\.path, then run this command again\./);
    expect(world.sudo().some((line) => line.includes('nvidia'))).toBe(false);
  });

  it('only notices the CDI support the person already has, and installs nothing', async () => {
    const world = gpu(UBUNTU, { executables: ['/usr/bin/nvidia-cdi-hook', '/usr/bin/nvidia-container-runtime'] });
    const ran = await join(world, ['the-code'], { 'Tailscale': true, 'Koala runs apps': true });
    expect(ran.asked.some((question) => question.includes('NVIDIA'))).toBe(false);
    expect(statesOf(ran.root)).toContain('nvidia-cdi already-done');
    expect(world.sudo().some((line) => line.includes('nvidia'))).toBe(false);
  });

  it('offers the toolkit on a machine with NVIDIA\'s CDI hook but not its container runtime, which the device plugin runs under', async () => {
    const world = gpu(UBUNTU, { executables: ['/usr/bin/nvidia-cdi-hook'] });
    const ran = await join(world, ['the-code'], { 'Tailscale': true, 'Koala runs apps': true, 'This machine has an NVIDIA GPU': true });
    expect(ran.asked.some((question) => question.startsWith('This machine has an NVIDIA GPU'))).toBe(true);
    expect(world.sudo().some((line) => line.startsWith('apt-get install -y nvidia-container-toolkit=1.20.1-1'))).toBe(true);
  });

  it('installs nothing when the person declines, saying the GPU goes unused', async () => {
    const world = gpu(UBUNTU);
    const ran = await join(world, ['the-code'], { 'Tailscale': true, 'Koala runs apps': true });
    expect(ran.said).toContain('without it Koala runs apps here on CPU only; run this command again to add it');
    expect(world.sudo().some((line) => line.includes('nvidia'))).toBe(false);
  });
});

describe('a join that fails', () => {
  it('says where and why, tells root the same why, and installs nothing from a download that is not the one Koala pins', async () => {
    const world = machine({ executables: ['/usr/bin/systemctl'], downloads: { ...DOWNLOADS, [pins.k3s.url('amd64')]: 'tampered' } });
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(ran.said).toContain(`failed: k3s ${pins.k3s.version} from ${pins.k3s.url('amd64')} is not the one Koala pins (its sha256 differs); nothing was installed`);
    expect(ran.root.reported.at(-1)).toMatchObject({ kind: 'failed', id: 'k3s' });
    expect(world.files.has(K3S_BINARY)).toBe(false);
    expect(world.files.has(K3S_MARKER)).toBe(false);
  });

  it('stops, saying why, when root names no private network', async () => {
    const world = machine({ tailscale: { installed: true }, root: () => ({ status: 200, body: { env: { KOALA_ROOT_URL: 'https://root.test', KOALA_DEVICE_ID: 'd', KOALA_DEVICE_TOKEN: 't', KOALA_ROOT_DIR: '/home/ada/koala' } } }) });
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('failed: Koala\'s root named no private network for this machine, and a machine takes work only over it');
  });

  it('says what root answered when it refuses the code', async () => {
    const world = machine({ tailscale: { installed: true }, root: () => ({ status: 401, body: 'that command has expired or was already used: make a new one on My Machines' }) });
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.said).toContain('failed: Koala refused this machine (401): that command has expired or was already used: make a new one on My Machines');
  });

  it('installs nothing of k3s when Tailscale gives the machine no private address', async () => {
    const world = machine({ tailscale: { installed: true, noAddress: true }, executables: ['/usr/bin/systemctl'] });
    const ran = await join(world, ['--yes', 'the-code'], {});
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('Tailscale gives this machine no private address, so Koala could not reach its cluster');
    expect(world.files.has(K3S_CONFIG)).toBe(false);
  });
});

describe('following root putting Koala on the machine it joined', () => {
  const AT = '2026-11-18T10:00:00.000Z';
  const install = (state: string, more: Record<string, string> = {}) => ({ id: 'install-1', machineId: 'device-1', state, at: AT, ...more });
  const event = (body: unknown, kind?: string): string => `${kind ? `event: ${kind}\n` : ''}data: ${JSON.stringify(body)}\n\n`;
  const CHART = 'Installing Koala\'s chart';
  const streamed = (...parts: Array<string | Error>) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        if (part instanceof Error) {
          controller.error(part);
          return;
        }
        controller.enqueue(new TextEncoder().encode(part));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const linux = (following: WorldOptions['following']) => machine({ files: { '/etc/os-release': UBUNTU }, executables: ['/usr/bin/systemctl'], ...(following ? { following } : {}) });
  const lastLine = (said: string): string => said.trimEnd().split('\n').at(-1)!.trim();

  it('prints each stage and line root records, with the machine\'s own token, ending when Koala is ready', async () => {
    const world = linux(() => streamed(
      ': beat\n\n',
      event({ install: install('asked') }),
      event({ install: install('installing', { stage: 'chart', title: CHART, line: 'waiting for deployment/koala' }) }),
      event({ install: install('installing', { stage: 'chart', title: CHART, line: 'deployment/koala is 1 of 1 ready' }) }),
      event({ install: install('ready', { stage: 'koala', title: 'Koala' }), url: 'https://bobby.koala.app' }),
    ));
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code, ran.said).toBe(0);
    expect(world.follows).toEqual(['Bearer token-1']);
    const after = ran.said.slice(ran.said.indexOf('Putting Koala on this machine'));
    expect(after.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual([
      'Putting Koala on this machine',
      CHART,
      'waiting for deployment/koala',
      'deployment/koala is 1 of 1 ready',
      'Koala is ready at https://bobby.koala.app',
    ]);
    expect(ran.said).not.toContain('This machine shows on My Machines in a moment');
  });

  it('ends with the stage it stopped at and why, failing, when the install failed', async () => {
    const world = linux(() => streamed(
      event({ install: install('installing', { stage: 'chart', title: CHART }) }),
      event({ install: install('failed', { stage: 'chart', title: CHART, why: 'the image could not be pulled' }) }),
    ));
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(lastLine(ran.said)).toBe(`Putting Koala on this machine stopped at ${CHART}: the image could not be pulled`);
  });

  it('says a move is a move', async () => {
    const world = linux(() => streamed(event({ install: { ...install('failed', { stage: 'keys', title: 'Bringing your keys', why: 'the pool copy is gone' }), move: true } })));
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(lastLine(ran.said)).toBe('Moving your Koala to this machine stopped at Bringing your keys: the pool copy is gone');
  });

  it('fails saying why when root would not put Koala on the machine', async () => {
    const world = linux(() => streamed(event({ why: 'your Koala is on laptop; moving it is a step of its own' }, 'stopped')));
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(lastLine(ran.said)).toBe('your Koala is on laptop; moving it is a step of its own');
  });

  it('follows again when the connection drops, printing nothing twice, until the install ends', async () => {
    const waiting = event({ install: install('installing', { stage: 'chart', title: CHART, line: 'waiting for deployment/koala' }) });
    const world = linux((followed) => {
      if (followed === 1) return streamed(waiting, new Error('other side closed'));
      if (followed === 2) return new Response('root is restarting', { status: 503 });
      return streamed(waiting, event({ install: install('ready', { stage: 'koala', title: 'Koala' }), url: 'https://bobby.koala.app' }));
    });
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code, ran.said).toBe(0);
    expect(world.follows).toHaveLength(3);
    expect(ran.said.match(/waiting for deployment\/koala/g)).toHaveLength(1);
    expect(ran.said).toContain('The connection to root dropped (other side closed); following again');
    expect(lastLine(ran.said)).toBe('Koala is ready at https://bobby.koala.app');
  });

  it('stops only the watching on Ctrl-C, saying putting Koala on the machine carries on', async () => {
    let interrupt = (): void => undefined;
    let released = false;
    const world = linux((_followed, signal) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event({ install: install('installing', { stage: 'chart', title: CHART }) })));
        signal?.addEventListener('abort', () => { controller.error(signal.reason); });
        setImmediate(() => { interrupt(); });
      },
    }), { status: 200 }));
    const ran = await join(world, ['--yes', 'the-code'], {}, { onInterrupt: (stop) => { interrupt = stop; return () => { released = true; }; } });
    expect(ran.code).toBe(130);
    expect(lastLine(ran.said)).toBe('Putting Koala on this machine carries on; My Machines shows it');
    expect(released).toBe(true);
  });

  it('ends as before when the join asked for no Koala', async () => {
    const world = linux(undefined);
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(0);
    expect(world.follows).toEqual(['Bearer token-1']);
    expect(ran.said).not.toContain('Putting Koala on this machine');
    expect(ran.said).toContain('This machine shows on My Machines in a moment');
  });

  it('fails saying what root answered when it will not let the machine follow', async () => {
    const world = linux(() => new Response('this machine is not one of Koala\'s: run the command from My Machines again', { status: 401 }));
    const ran = await join(world, ['--yes', 'the-code']);
    expect(ran.code).toBe(1);
    expect(ran.said).toContain('root would not say how putting Koala on this machine goes (401): this machine is not one of Koala\'s: run the command from My Machines again');
  });

  it('follows nothing when the service was not set up, since nothing runs to put Koala there', async () => {
    const world = linux(() => { throw new Error('followed with no service'); });
    const ran = await join(world, ['--yes', '--no-service', 'the-code']);
    expect(ran.code, ran.said).toBe(0);
    expect(world.follows).toEqual([]);
  });
});
