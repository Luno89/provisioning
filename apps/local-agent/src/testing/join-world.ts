import path from 'node:path';
import type { Command } from '@koala/provision';
import { fakeCommands, type Answer, type FakeCommands } from '@koala/provision/testing';
import type { JoinHost } from '../join/host.js';

export interface WorldOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  uid?: number;
  files?: Record<string, string>;
  executables?: string[];
  tailscale?: { server?: string; ip?: string; installed?: boolean; noAddress?: boolean };
  userSystemd?: boolean;
  refuse?: (command: Command) => Answer | undefined;
  root?: (body: Record<string, unknown>) => { status: number; body: unknown };
  downloads?: Record<string, string>;
  pci?: string | false;
}

export const HOME = '/home/ada';
export const AGENT_DIR = `${HOME}/.local/share/koala/machine`;
export const NODE = `${HOME}/.local/share/koala/node-v22/bin/node`;
export const PATHS = ['/usr/local/bin', '/usr/bin', '/usr/sbin', '/bin'];

export interface World {
  host: JoinHost;
  commands: FakeCommands;
  files: Map<string, string>;
  executables: Set<string>;
  modes: Map<string, number>;
  joins: Record<string, unknown>[];
  ran(): string[];
  sudo(): string[];
  service: { enabled: boolean; activeSince: number | undefined };
  mesh: { server: string | undefined; ip: string | undefined };
  tick(): void;
}

const argvOf = (command: Command): string => [command.command, ...(command.args ?? [])].join(' ');

export function joinWorld(options: WorldOptions = {}): World {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const executables = new Set<string>(options.executables ?? []);
  const modes = new Map<string, number>();
  const modified = new Map<string, number>();
  const joins: Record<string, unknown>[] = [];
  let clock = 1_000;
  const tick = () => { clock += 10; };
  const put = (file: string, content: string, executable = false) => {
    files.set(file, content);
    modified.set(file, clock * 1000);
    if (executable) executables.add(file);
  };
  for (const file of files.keys()) modified.set(file, clock * 1000);
  const mesh = { server: options.tailscale?.server, ip: options.tailscale?.ip };
  if (options.tailscale?.installed === true) executables.add('/usr/bin/tailscale');
  if (options.pci !== false) executables.add('/usr/bin/lspci');
  const service = { enabled: false, activeSince: undefined as number | undefined };
  let scratches = 0;

  const answer = (command: Command): Answer | undefined => {
    const refused = options.refuse?.(command);
    if (refused) return refused;
    const args = command.args ?? [];
    const at = (index: number): string => args[index] ?? '';
    switch (command.command) {
      case 'sudo': return {};
      case 'test': return { code: files.has(at(1)) ? 0 : 1 };
      case 'cat': return files.has(at(0)) ? { stdout: files.get(at(0))! } : { code: 1, stderr: `cat: ${at(0)}: No such file or directory` };
      case 'install': {
        const plain = args.filter((arg) => arg !== '-D');
        const mode = plain[1]!;
        const [from, to] = plain.slice(2) as [string, string];
        if (!files.has(from)) return { code: 1, stderr: `install: cannot stat '${from}': No such file or directory` };
        put(to, files.get(from)!, /[1357]/.test(mode[0] ?? ''));
        modes.set(to, Number.parseInt(mode, 8));
        return {};
      }
      case 'tar': {
        const archive = files.get(at(1));
        if (archive === undefined) return { code: 2, stderr: 'tar: no such archive' };
        for (const [name, content] of Object.entries((JSON.parse(archive) as { files: Record<string, string> }).files)) put(path.join(at(3), name), content, true);
        return {};
      }
      case 'sh':
        put('/usr/local/bin/k3s-killall.sh', '#!/bin/sh\n', true);
        put('/usr/local/bin/k3s-uninstall.sh', '#!/bin/sh\n', true);
        put('/etc/systemd/system/k3s.service', `[Unit]\nDescription=k3s ${command.env?.INSTALL_K3S_VERSION ?? ''}\n`);
        return { stdout: '[INFO]  Skipping k3s download and verify\n[INFO]  systemd: Creating service file /etc/systemd/system/k3s.service\n' };
      case 'visudo': return { stdout: `${at(1)}: parsed OK\n` };
      case 'apt-get':
      case 'dnf':
        if (at(0) === 'install') {
          put('/usr/bin/nvidia-cdi-hook', '', true);
          put('/usr/bin/nvidia-container-runtime', '', true);
        }
        return {};
      case 'loginctl': return {};
      case 'lspci': return options.pci === false || args.join(' ') !== '-vmmnnk' ? undefined : { stdout: options.pci ?? '' };
      case 'tailscale':
        if (at(0) === 'debug') return { stdout: JSON.stringify({ ControlURL: mesh.server ?? 'https://controlplane.tailscale.com', LoggedOut: mesh.server === undefined, WantRunning: mesh.server !== undefined, Config: { PrivateNodeKey: 'privkey:never-shown' } }) };
        if (at(0) === 'ip') return mesh.ip ? { stdout: `${mesh.ip}\n` } : { code: 1, stderr: 'no current Tailscale IPs; state: NeedsLogin' };
        if (at(0) === 'up') {
          mesh.server = args.find((arg) => arg.startsWith('--login-server='))?.slice('--login-server='.length);
          mesh.ip = options.tailscale?.noAddress ? undefined : '100.64.0.7';
          return {};
        }
        return { code: 1 };
      case 'systemctl': {
        const user = at(0) === '--user';
        const rest = user ? args.slice(1) : args;
        if (!user) return rest[0] === 'is-failed' ? { code: 1, stdout: 'active\n' } : {};
        if (rest[0] === 'show-environment') return { code: options.userSystemd === false ? 1 : 0 };
        if (rest[0] === 'enable') service.enabled = true;
        if (rest[0] === 'restart') service.activeSince = clock;
        if (rest[0] === 'is-enabled') return { code: service.enabled ? 0 : 1, stdout: service.enabled ? 'enabled\n' : 'disabled\n' };
        if (rest[0] === 'show') return { stdout: `ActiveState=${service.activeSince === undefined ? 'inactive' : 'active'}\nActiveEnterTimestamp=${service.activeSince === undefined ? '' : `@${service.activeSince}`}\n` };
        return {};
      }
      default:
        if (command.command.endsWith('/helm')) return files.has(command.command) ? { stdout: files.get(command.command)! } : undefined;
        return undefined;
    }
  };
  const commands = fakeCommands(answer);

  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    joins.push(body);
    const replied = options.root?.(body) ?? {
      status: 200,
      body: { env: { KOALA_ROOT_URL: 'https://root.test', KOALA_DEVICE_ID: `device-${joins.length}`, KOALA_DEVICE_TOKEN: `token-${joins.length}`, KOALA_ROOT_DIR: String(body.rootDir), MESH_LOGIN_SERVER: 'https://mesh.root.test', MESH_AUTH_KEY: 'hskey-the-mesh-key', KOALA_REGISTRY: 'registry.root.test:5000', KOALA_AGENT_SHA256: 'a'.repeat(64) } },
    };
    void input;
    return new Response(typeof replied.body === 'string' ? replied.body : JSON.stringify(replied.body), { status: replied.status });
  }) as typeof fetch;

  const host: JoinHost = {
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    uid: options.uid ?? 1000,
    user: 'ada',
    group: 'ada',
    home: HOME,
    hostname: 'desk',
    os: 'Linux x86_64',
    env: { PATH: PATHS.join(':'), HOME },
    at: (file) => file,
    read: async (file) => files.get(file),
    executable: async (file) => executables.has(file),
    readOwn: async (file) => files.get(file),
    ownExecutable: async (file) => executables.has(file),
    which: async (name) => PATHS.map((dir) => path.join(dir, name)).find((file) => executables.has(file)),
    modified: async (file) => modified.get(file),
    writeOwn: async (file, content, mode) => {
      put(file, content);
      modes.set(file, mode);
    },
    makeFolder: async (folder) => folder,
    scratch: async () => {
      scratches += 1;
      const dir = `/tmp/koala-join-${scratches}`;
      return { dir, remove: async () => { for (const file of [...files.keys()]) if (file.startsWith(`${dir}/`)) files.delete(file); } };
    },
    download: async (what, url, to) => {
      const content = options.downloads?.[url];
      if (content === undefined) throw new Error(`${what} could not be downloaded: ${url} answered 404`);
      if (content === 'tampered') throw new Error(`${what} from ${url} is not the one Koala pins (its sha256 differs); nothing was installed`);
      put(to, content);
    },
    fetch: fetcher,
  };

  return {
    host,
    commands,
    files,
    executables,
    modes,
    joins,
    ran: () => commands.ran.map(argvOf),
    sudo: () => commands.ran.filter((command) => command.sudo).map(argvOf),
    service,
    mesh,
    tick,
  };
}

export const archive = (entries: Record<string, string>): string => JSON.stringify({ files: entries });
