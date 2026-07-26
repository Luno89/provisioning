/**
 * ProvisionRemoteHostActivity
 *
 * The "generic SSH k3s bootstrap" piece of the distributed-systems plan's Phase 2: given SSH
 * access to an already-reachable machine (a GPU workstation on the Headscale mesh today; a
 * freshly-created VPS in Phase 3), installs a single-node k3s cluster on it and produces a
 * kubeconfig rewritten to point at the *mesh* address rather than 127.0.0.1 — so every existing
 * downstream piece (CDKTF's K8sProvider, ClusterProxyService, app deployment) keeps working
 * unmodified against this cluster exactly as it does today against a local k3d one. Called from
 * ProvisionClusterActivity's `provider === 'remote'` branch, which then runs the same CDKTF
 * deploy tail (monitoring/Traefik stack) every other provider already shares.
 *
 * Shells out to the system `ssh`/`scp` binaries rather than an SSH client library — matches this
 * codebase's existing convention of shelling out to kubectl/helm/docker/k3d rather than pulling
 * in SDKs (see InfrastructureService).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface ProvisionRemoteHostArgs {
  physicalName: string;
  host: string; // mesh IP (or any SSH-reachable address) — what the kubeconfig's server field is rewritten to
  username: string;
  privateKey: string; // PEM, decrypted — caller (ProvisionClusterActivity) is responsible for decrypting before this
  port?: number;
  // The port k3s's API server (normally 6443) is reachable on from HERE, if different from 6443
  // itself — needed when `host` is behind port-forwarding rather than directly routable (e.g.
  // tests/lib/disposable-vm.ts's QEMU hostfwd). A real mesh target reached over Headscale never
  // needs this; 6443 is directly reachable at the mesh IP there.
  k3sApiPort?: number;
}

export interface ProvisionRemoteHostResult {
  kubeconfigPath: string;
}

// The install script needs root to install a systemd service + binary into /usr/local/bin — for
// any user other than root, we require *passwordless* sudo (`sudo -n`, fails loudly instead of
// hanging on a password prompt) rather than silently degrading. This matches how most infra
// automation (Ansible, Terraform provisioners) already assumes root/passwordless-sudo access for
// OS-level bootstrap; documented here rather than discovered as a confusing timeout.
function sshPrefix(username: string): string {
  return username === 'root' ? '' : 'sudo -n ';
}

async function runSsh(host: string, port: number, username: string, keyPath: string, command: string): Promise<string> {
  const { stdout } = await execFileAsync('ssh', [
    '-i', keyPath,
    '-p', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    `${username}@${host}`,
    command,
  ], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function ProvisionRemoteHostActivity(
  args: ProvisionRemoteHostArgs,
): Promise<ProvisionRemoteHostResult> {
  const port = args.port ?? 22;
  const kubeconfigPath = `/tmp/kubeconfig-${args.physicalName}`;
  const keyPath = path.join(os.tmpdir(), `ssh-key-${args.physicalName}-${Date.now()}`);

  await fs.writeFile(keyPath, args.privateKey.endsWith('\n') ? args.privateKey : `${args.privateKey}\n`, { mode: 0o600 });

  try {
    const prefix = sshPrefix(args.username);

    // Idempotent — a re-run (e.g. after a retried Temporal activity) against an already-bootstrapped
    // host just skips straight to waiting for readiness instead of re-running the installer.
    const alreadyInstalled = await runSsh(args.host, port, args.username, keyPath, 'command -v k3s')
      .then(() => true)
      .catch(() => false);

    if (!alreadyInstalled) {
      // K3S_KUBECONFIG_MODE=644 makes the kubeconfig world-readable so the fetch step below
      // doesn't itself need sudo — confirmed against k3s's own install script env vars.
      //
      // --disable=traefik: k3s bundles its own Traefik via a HelmChart CR that its in-cluster
      // helm-controller continuously reconciles — confirmed live this fights with the CDKTF-
      // deployed Traefik this platform always wants instead (ProvisionClusterActivity's step-5
      // cleanup does `helm uninstall traefik`, but that only removes the *release*, not the
      // underlying HelmChart CR, so k3s's controller just reinstalls it moments later; ended up
      // as a CrashLoopBackOff'ing `helm-install-traefik` job fighting CDKTF's traefik namespace
      // for the same IngressClass/ports). Disabling at install time avoids the fight entirely,
      // matching how ProvisionClusterActivity's cleanup step already assumes traefik is absent
      // before CDKTF applies its own.
      await runSsh(
        args.host, port, args.username, keyPath,
        `curl -sfL https://get.k3s.io | ${prefix}K3S_KUBECONFIG_MODE="644" INSTALL_K3S_EXEC="server --disable=traefik" sh -`,
      );
    }

    // Wait for the API server to report a Ready node.
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const nodesJson = await runSsh(args.host, port, args.username, keyPath, `${prefix}k3s kubectl get nodes -o json`);
        const nodes = JSON.parse(nodesJson).items ?? [];
        if (nodes.some((n: any) => n.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True'))) {
          ready = true;
          break;
        }
      } catch {
        // Not up yet — normal during install.
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!ready) {
      throw new Error(`k3s on ${args.host} did not report a Ready node in time`);
    }

    const rawKubeconfig = await runSsh(args.host, port, args.username, keyPath, 'cat /etc/rancher/k3s/k3s.yaml');
    // k3s's default kubeconfig points at 127.0.0.1 (correct only from the node's own perspective)
    // — rewrite to the mesh IP so this backend, running elsewhere on the mesh, can actually reach it.
    const rewritten = rawKubeconfig.replace(/https:\/\/127\.0\.0\.1:6443/g, `https://${args.host}:${args.k3sApiPort ?? 6443}`);
    await fs.writeFile(kubeconfigPath, rewritten, 'utf-8');

    return { kubeconfigPath };
  } finally {
    await fs.rm(keyPath, { force: true });
  }
}

/**
 * Uninstalls k3s from the remote host — the mirror image of the bootstrap above, called from
 * DestroyClusterActivity for provider === 'remote'. k3s's own installer drops an uninstall
 * script at a fixed path; best-effort (wrapped by the caller) since a host that's already gone
 * (e.g. a since-destroyed VPS) can't be SSH'd into to clean up, and that's fine — nothing left
 * behind on this side but the now-removed kubeconfig file.
 */
export async function DestroyRemoteHostActivity(args: ProvisionRemoteHostArgs): Promise<void> {
  const port = args.port ?? 22;
  const keyPath = path.join(os.tmpdir(), `ssh-key-destroy-${args.physicalName}-${Date.now()}`);
  await fs.writeFile(keyPath, args.privateKey.endsWith('\n') ? args.privateKey : `${args.privateKey}\n`, { mode: 0o600 });

  try {
    const prefix = sshPrefix(args.username);
    await runSsh(args.host, port, args.username, keyPath, `${prefix}/usr/local/bin/k3s-uninstall.sh`);
  } finally {
    await fs.rm(keyPath, { force: true });
  }
}
