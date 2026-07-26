/**
 * Boots a real, disposable QEMU/KVM virtual machine — used by
 * tests/remote-host-integration.ts to prove the distributed-systems plan's Phase 2
 * ("generic SSH-based k3s bootstrap for remote hosts") actually works, without needing a real
 * VPS or touching the developer's own machine. A real VM (not a container) is required here:
 * k3s's install script manages itself via systemd, which a plain Docker container's init
 * doesn't run — confirmed while investigating this test, a container-based target isn't a
 * faithful stand-in for what Phase 2 actually targets (a real VPS or bare-metal workstation).
 *
 * Shells out to `qemu-system-x86_64`/`qemu-img`/`cloud-localds`/`ssh-keygen` — matches this
 * codebase's existing convention of shelling out to CLI tools rather than pulling in SDKs.
 * Requires `qemu-kvm`, `cloud-utils` (cloud-localds), and `genisoimage` to be installed, and
 * /dev/kvm to be accessible — fails fast with a clear message otherwise.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fssync from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { calculateRequiredVmMemoryMB } from './memory-budget.js';

const execFileAsync = promisify(execFile);

const CACHE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.vm-cache');
const BASE_IMAGE_URL = 'https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img';
const BASE_IMAGE_PATH = path.join(CACHE_DIR, 'ubuntu-22.04-server-cloudimg-amd64.img');

export interface DisposableVm {
  host: string;
  port: number;
  /**
   * The HOST-side port forwarded to the VM's k3s API server (VM port 6443). Confirmed live this
   * is required, not optional: with only SSH forwarded, CDKTF's kubectl-equivalent call to
   * "https://127.0.0.1:6443" silently hit THIS machine's own real management cluster (also
   * listening on 127.0.0.1:6443) instead of the VM's — a TLS cert mismatch, not a connection
   * error, so it looked like a k3s misconfiguration until traced to the missing port-forward.
   * A real remote target (a real VPS/workstation with its own mesh IP) never has this collision;
   * it's purely an artifact of this VM living on the same host as the thing testing it.
   */
  k3sApiPort: number;
  username: string;
  privateKeyPath: string;
  privateKey: string;
  destroy: () => Promise<void>;
}

async function checkPrereqs(): Promise<void> {
  const missing: string[] = [];
  for (const bin of ['qemu-system-x86_64', 'qemu-img', 'cloud-localds', 'ssh-keygen', 'ssh']) {
    try {
      await execFileAsync('which', [bin]);
    } catch {
      missing.push(bin);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required tools for disposable-VM testing: ${missing.join(', ')}. ` +
      `Install with: sudo dnf install -y qemu-kvm cloud-utils genisoimage`,
    );
  }
  if (!fssync.existsSync('/dev/kvm')) {
    throw new Error('/dev/kvm not found — hardware virtualization is required (check BIOS/VM settings and that the kvm kernel module is loaded).');
  }
  try {
    await fs.access('/dev/kvm', fssync.constants.R_OK | fssync.constants.W_OK);
  } catch {
    throw new Error('/dev/kvm exists but is not accessible to this user — check its permissions/group.');
  }
}

async function ensureBaseImage(): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  if (fssync.existsSync(BASE_IMAGE_PATH)) {
    return BASE_IMAGE_PATH;
  }
  console.log(`  ⬇  Downloading Ubuntu 22.04 cloud image (~600MB, cached at ${BASE_IMAGE_PATH} for future runs)...`);
  const tmpPath = `${BASE_IMAGE_PATH}.downloading`;
  await execFileAsync('curl', ['-fL', '-o', tmpPath, BASE_IMAGE_URL], { maxBuffer: 1024 * 1024 * 1024 });
  await fs.rename(tmpPath, BASE_IMAGE_PATH);
  return BASE_IMAGE_PATH;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a free port'))));
    });
    srv.on('error', reject);
  });
}

/**
 * Boots a fresh Ubuntu 22.04 VM reachable at 127.0.0.1:<forwarded-port> over SSH as a
 * passwordless-sudo user — everything ProvisionRemoteHostActivity needs from a real target.
 */
export async function createDisposableVm(name: string): Promise<DisposableVm> {
  await checkPrereqs();
  const baseImage = await ensureBaseImage();

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `disposable-vm-${name}-`));
  const overlayPath = path.join(workDir, 'disk.qcow2');
  const seedPath = path.join(workDir, 'seed.iso');
  const userDataPath = path.join(workDir, 'user-data.yaml');
  const metaDataPath = path.join(workDir, 'meta-data.yaml');
  const keyPath = path.join(workDir, 'id_ed25519');
  const pidPath = path.join(workDir, 'qemu.pid');
  const serialLogPath = path.join(workDir, 'serial.log');

  console.log(`  🔑 Generating throwaway SSH keypair for ${name}...`);
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', `disposable-vm-${name}`]);
  const publicKey = (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim();
  const privateKey = await fs.readFile(keyPath, 'utf8');

  // Without an explicit size, the overlay inherits the base image's tiny ~2.2GB virtual size —
  // confirmed live: k3s's install ran fine but the k3s service itself then failed on every
  // startup with "no space left on device" partway through extracting its bundled images.
  // Ubuntu cloud images run cloud-init's growpart/resizefs modules by default on first boot, so
  // giving the overlay a real virtual size here is all that's needed — no extra cloud-init config.
  console.log(`  💽 Creating copy-on-write overlay disk for ${name} (20G, auto-grown by cloud-init)...`);
  await execFileAsync('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', baseImage, overlayPath, '20G']);

  await fs.writeFile(userDataPath, [
    '#cloud-config',
    'users:',
    '  - name: ubuntu',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    shell: /bin/bash',
    '    ssh_authorized_keys:',
    `      - ${publicKey}`,
    'ssh_pwauth: false',
    'package_update: false',
    'package_upgrade: false',
  ].join('\n'));
  await fs.writeFile(metaDataPath, [
    `instance-id: ${name}-${Date.now()}`,
    `local-hostname: ${name}`,
  ].join('\n'));

  console.log(`  📀 Building cloud-init seed image for ${name}...`);
  await execFileAsync('cloud-localds', [seedPath, userDataPath, metaDataPath]);

  const sshPort = await findFreePort();
  const k3sApiPort = await findFreePort();

  // -cpu host: without it, QEMU defaults to a conservative virtual CPU model that doesn't expose
  // the host's real instruction set — confirmed live this made loki's minio sub-component crash
  // outright ("Fatal glibc error: CPU does not support x86-64-v2"), not a resource-pressure issue.
  // `-cpu host` passes the real host CPU's features straight through under KVM, matching what
  // every other pod on this platform already gets on bare metal.
  //
  // Memory is calculated (see tests/lib/memory-budget.ts), not guessed — repeatedly guessing
  // round numbers (2048 → 4096 → 6144 → 8192MB) here previously burned several full
  // deploy-and-fail cycles chasing a real "Insufficient memory" scheduling failure that turned
  // out to be an unconstrained Loki chart default (~9.8Gi for one sub-component alone, now fixed
  // in constructs/logging.ts) — no amount of guessing the VM size upward would have reliably
  // found that; measuring what's actually requested did.
  const memoryMB = calculateRequiredVmMemoryMB();
  console.log(`  🚀 Booting ${name} (KVM-accelerated, ${memoryMB}MB RAM, SSH on 127.0.0.1:${sshPort}, k3s API on 127.0.0.1:${k3sApiPort})...`);
  await execFileAsync('qemu-system-x86_64', [
    '-enable-kvm',
    '-cpu', 'host',
    '-m', String(memoryMB),
    '-smp', '2',
    '-display', 'none',
    '-serial', `file:${serialLogPath}`,
    '-no-reboot',
    '-drive', `file=${overlayPath},if=virtio,format=qcow2`,
    '-drive', `file=${seedPath},if=virtio,format=raw,readonly=on`,
    '-nic', `user,hostfwd=tcp::${sshPort}-:22,hostfwd=tcp::${k3sApiPort}-:6443`,
    '-daemonize',
    '-pidfile', pidPath,
  ]);

  const destroy = async () => {
    try {
      const pid = (await fs.readFile(pidPath, 'utf8')).trim();
      if (pid) process.kill(Number(pid), 'SIGKILL');
    } catch {
      // Already dead or never started — fine.
    }
    await fs.rm(workDir, { recursive: true, force: true });
  };

  console.log(`  ⏳ Waiting for ${name} to finish booting and accept SSH...`);
  const deadline = Date.now() + 5 * 60 * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      await execFileAsync('ssh', [
        '-i', keyPath,
        '-p', String(sshPort),
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=5',
        '-o', 'BatchMode=yes',
        'ubuntu@127.0.0.1',
        'cloud-init status --wait',
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!ready) {
    await destroy();
    throw new Error(`${name} did not become SSH-reachable within 5 minutes — see ${serialLogPath} for boot console output`);
  }
  console.log(`  ✅ ${name} is up and SSH-reachable`);

  return {
    host: '127.0.0.1',
    port: sshPort,
    k3sApiPort,
    username: 'ubuntu',
    privateKeyPath: keyPath,
    privateKey,
    destroy,
  };
}
