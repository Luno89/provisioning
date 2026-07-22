import { spawn, ChildProcess, exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { Server as SocketServer } from 'socket.io';

import os from 'os';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const CDKTF_DIR = path.join(PROJECT_ROOT, 'packages/cdktf-infra');
const LOG_DIR = path.join(PROJECT_ROOT, 'apps/backend/data/logs');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube/config');
// Host-backed local-path-provisioner storage, keyed by cluster name. Bind-mounting this
// into the node (instead of relying on k3d's default anonymous volume) means PVC data
// survives `k3d cluster delete` — which `npm run clean-dev` and "Destroy Cluster" both
// trigger — instead of being deleted along with the node container's volumes.
const K3D_STORAGE_ROOT = path.join(PROJECT_ROOT, '.k3d-storage');
// vLLM model weights use a hostPath volume (see constructs/vllm.ts) at a fixed path so they
// survive namespace/app destroy, not just cluster delete. On k3d that path only exists inside
// the node container's own ephemeral filesystem unless bind-mounted — this is that mount,
// deliberately a SINGLE shared directory (not per-cluster like K3D_STORAGE_ROOT) so a model
// downloaded once is reused across every k3d cluster instead of being re-fetched per cluster.
const VLLM_CACHE_HOST_DIR = path.join(PROJECT_ROOT, '.vllm-model-cache');

export interface ExecuteOptions {
  env?: Record<string, string> | undefined;
  logFile?: string | undefined;
  resourceId?: string | undefined;
  io?: SocketServer | undefined;
  timeout?: number | undefined;
}

/**
 * Service to handle low-level infrastructure commands.
 */
function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export class InfrastructureService {
  private activeStreams: Map<string, ChildProcess> = new Map();

  getLogPath(logId: string) {
    return path.join(LOG_DIR, `${logId}-${Date.now()}.log`);
  }

  async deploy(stackName: string, options: ExecuteOptions = {}) {
    return this.runCommand('npx', ['cdktf', 'deploy', stackName, '--auto-approve'], stackName, options);
  }

  async destroy(stackName: string, options: ExecuteOptions = {}) {
    return this.runCommand('npx', ['cdktf', 'destroy', stackName, '--auto-approve'], stackName, options);
  }

  async buildImage(tag: string, dockerfile: string, context: string, options: ExecuteOptions = {}) {
    const dockerfilePath = path.join(context, 'Dockerfile');
    await fs.writeFile(dockerfilePath, dockerfile);
    return this.runCommand('docker', ['build', '-t', tag, '.'], tag, { ...options, env: { ...options.env, CD_DIR: context } });
  }

  async pullImage(imageTag: string, options: ExecuteOptions = {}) {
    return this.runCommand('docker', ['pull', imageTag], imageTag, options);
  }

  async importImage(clusterName: string, imageTag: string, options: ExecuteOptions = {}) {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['image', 'import', imageTag, '-c', clusterName], imageTag, options);
  }

  async pullAndImportImage(clusterName: string, imageTag: string, options: ExecuteOptions = {}) {
    await this.pullImage(imageTag, options);
    await this.importImage(clusterName, imageTag, options);
  }

  async waitForNamespaceDeletion(namespace: string, kubeconfigPath?: string, maxWaitMs: number = 180000): Promise<void> {
    try {
      const args = ['delete', 'namespace', namespace, '--ignore-not-found=true', '--timeout=3m'];
      await this.runKubectl(args, kubeconfigPath);
    } catch {}

    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const output = await this.runKubectl(['get', 'namespace', namespace, '-o', 'json'], kubeconfigPath);
        const nsObj = JSON.parse(output);
        if (!nsObj || nsObj.status?.phase === 'Terminating') {
          if (Date.now() - startTime > 30000) {
            try {
              await this.runKubectl(
                ['patch', 'namespace', namespace, '-p', '{"spec":{"finalizers":[]}}', '--type=merge'],
                kubeconfigPath
              );
            } catch {}
          }
        }
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private async dockerContainerExists(containerName: string): Promise<boolean> {
    try {
      await execAsync(`docker inspect ${escapeShellArg(containerName)}`);
      return true;
    } catch {
      return false;
    }
  }

  async runKubectl(args: string[], kubeconfig?: string) {
    const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
    if (match) {
      const clusterName = match[1] ?? 'unknown';
      const containerName = `k3d-${clusterName}-server-0`;

      // Only true k3d clusters have a matching server container to exec into. GPU-attached
      // clusters (and the system cluster) share this /tmp/kubeconfig-<name> naming convention
      // but attach to the native k3s management cluster instead (see ProvisionClusterActivity)
      // — no such container exists there, so fall through to direct kubectl below.
      if (await this.dockerContainerExists(containerName)) {
        const cleanArgs: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === undefined) continue;
          if (arg === '--context') {
            i++; // skip context name
          } else {
            cleanArgs.push(arg);
          }
        }

        const escapedArgs = cleanArgs.map(escapeShellArg).join(' ');
        const { stdout } = await execAsync(`docker exec ${containerName} kubectl ${escapedArgs}`);
        return stdout;
      }
    }

    const escapedArgs = args.map(escapeShellArg).join(' ');
    const { stdout } = await execAsync(`${escapeShellArg(path.join(BIN_DIR, 'kubectl'))} ${escapedArgs}`, {
      env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
    });
    return stdout;
  }

  async runHelm(args: string[], kubeconfig?: string) {
    const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
    if (match) {
      const clusterName = match[1] ?? 'unknown';
      const containerName = `k3d-${clusterName}-server-0`;

      // Same reasoning as runKubectl above — only exec into a container that actually exists.
      if (await this.dockerContainerExists(containerName)) {
        // Ensure helm binary exists in the container
        try {
          await execAsync(`docker exec ${containerName} ls /bin/helm`);
        } catch {
          // If not, copy it from host bin/helm-linux
          try {
            const hostHelmPath = existsSync(path.join(BIN_DIR, 'helm-linux'))
              ? path.join(BIN_DIR, 'helm-linux')
              : path.join(BIN_DIR, 'helm');
            await execAsync(`docker cp ${escapeShellArg(hostHelmPath)} ${containerName}:/bin/helm`);
            await execAsync(`docker exec ${containerName} chmod +x /bin/helm`);
          } catch (err: any) {
            console.error(`Failed to copy helm to container ${containerName}: ${err.message}`);
          }
        }

        const cleanArgs = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === undefined) continue;
          if (arg === '--kube-context') {
            i++; // skip context name
          } else {
            cleanArgs.push(arg);
          }
        }

        const escapedArgs = cleanArgs.map(escapeShellArg).join(' ');
        const { stdout } = await execAsync(`docker exec -e KUBECONFIG=/etc/rancher/k3s/k3s.yaml ${containerName} helm ${escapedArgs}`);
        return stdout;
      }
    }

    const escapedArgs = args.map(escapeShellArg).join(' ');
    const { stdout } = await execAsync(`${escapeShellArg(path.join(BIN_DIR, 'helm'))} ${escapedArgs}`, {
      env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
    });
    return stdout;
  }

  async getKubeconfig(name: string) {
    const { stdout } = await execAsync(`${path.join(BIN_DIR, 'k3d')} kubeconfig get ${name}`);
    return stdout;
  }

  /**
   * GPU-enabled "clusters" don't get their own physical cluster — they attach to the shared,
   * always-up management cluster (native k3s on Linux, k3d on macOS; see scripts/cluster.sh).
   * Its credentials already live in the default kubeconfig under context `k3d-provisioning-lunorica`
   * (native k3s's kubeconfig is merged in under that same name at cluster-start time — see
   * cluster.sh's native_k3s_ensure_running). Extracts just that context and renames it to
   * `k3d-<physicalName>` so every existing `--context k3d-<name>` call site works unmodified.
   */
  async getManagementClusterKubeconfig(physicalName: string): Promise<string> {
    const managementContext = 'k3d-provisioning-lunorica';
    const { stdout } = await execAsync(
      `${path.join(BIN_DIR, 'kubectl')} config view --minify --raw --context=${managementContext} --kubeconfig=${DEFAULT_KUBECONFIG}`,
    );
    if (!stdout.includes(managementContext)) {
      throw new Error(
        `Management cluster context "${managementContext}" not found in ${DEFAULT_KUBECONFIG}. ` +
        `Is the management cluster running? (Linux: sudo systemctl start k3s-provisioning-lunorica, or re-run npm run dev)`,
      );
    }
    return stdout.split(managementContext).join(`k3d-${physicalName}`);
  }

  async listLocalClusters(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`${path.join(BIN_DIR, 'k3d')} cluster list --no-headers`);
      return stdout
        .split('\n')
        .map(line => (line.split(/\s+/)[0] ?? ''))
        .filter((name): name is string => !!name);
    } catch {
      return [];
    }
  }

  async createLocalCluster(name: string, options: ExecuteOptions = {}) {
    try {
      const existing = await this.listLocalClusters();
      if (existing.includes(name)) {
        console.log(`[InfrastructureService] Cluster ${name} already exists. Skipping k3d cluster creation.`);
        return { stdout: `Cluster ${name} already exists.`, logFile: this.getLogPath(name) };
      }
    } catch (err: any) {
      console.warn(`[InfrastructureService] Failed to check existing clusters: ${err.message}`);
    }

    let resolvConfPath = '/etc/resolv.conf';
    try {
      if (existsSync('/run/systemd/resolve/resolv.conf')) {
        resolvConfPath = '/run/systemd/resolve/resolv.conf';
      } else if (existsSync('/var/run/systemd/resolve/resolv.conf')) {
        resolvConfPath = '/var/run/systemd/resolve/resolv.conf';
      }
    } catch (e) {}

    const args = [
      'cluster', 'create', name,
      '--wait',
      '--k3s-arg', `--resolv-conf=${resolvConfPath}@server:*`
    ];

    if (resolvConfPath !== '/etc/resolv.conf') {
      args.push('--volume', `${resolvConfPath}:${resolvConfPath}@server:*`);
    }

    // Bind-mount host storage for local-path-provisioner so PVC data (model caches, DB
    // volumes, etc.) survives cluster deletion/recreation instead of living only in a
    // k3d-managed volume that gets torn down with the node containers.
    const hostStorageDir = path.join(K3D_STORAGE_ROOT, name);
    await fs.mkdir(hostStorageDir, { recursive: true });
    args.push('--volume', `${hostStorageDir}:/var/lib/rancher/k3s/storage@server:*;agent:*`);

    await fs.mkdir(VLLM_CACHE_HOST_DIR, { recursive: true });
    args.push('--volume', `${VLLM_CACHE_HOST_DIR}:/var/lib/rancher/vllm-model-cache@server:*;agent:*`);

    await this.runCommand(path.join(BIN_DIR, 'k3d'), args, name, {
      ...options,
      env: {
        ...options.env,
        K3D_FIX_DNS: '0'
      }
    });

    try {
      await execAsync(`docker network connect k3d-${name} provisioner-nginx`);
    } catch {
      console.warn(`[InfrastructureService] Could not connect provisioner-nginx to k3d-${name} network`);
    }

    return { stdout: `Cluster ${name} created.`, logFile: this.getLogPath(name) };
  }

  async deleteLocalCluster(name: string, options: ExecuteOptions = {}) {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['cluster', 'delete', name], name, options);
  }

  async getK3dServerIp(clusterName: string): Promise<string> {
    const { stdout } = await execAsync(
      `docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' k3d-${clusterName}-server-0`
    );
    return stdout.trim();
  }

  // Native k3s (the system/management cluster) runs directly on the host, not inside a k3d
  // node container — there's no container to `docker inspect` for a node IP. The provisioner-
  // nginx container is Docker-bridge-networked, so its bridge gateway IP is what actually
  // routes back to the host from inside it (127.0.0.1 there would mean the Nginx container
  // itself, not the host). Verified live: a NodePort service reachable at
  // <bridge-gateway>:<nodePort> from inside provisioner-nginx returns the real pod response.
  async getHostGatewayIp(): Promise<string> {
    const { stdout } = await execAsync(
      `docker inspect provisioner-nginx --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'`
    );
    return stdout.trim();
  }

  async disconnectNginxFromNetwork(clusterName: string): Promise<void> {
    try {
      await execAsync(`docker network disconnect k3d-${clusterName} provisioner-nginx`);
    } catch {
      console.warn(`[InfrastructureService] Could not disconnect provisioner-nginx from k3d-${clusterName} network`);
    }
  }

  async streamLogs(resourceId: string, args: string[], io: SocketServer, room: string, kubeconfig?: string) {
    this.stopStream(resourceId);

    const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
    let child;
    // Same reasoning as runKubectl/runHelm — only exec into a container that actually exists
    // (GPU-attached/system clusters share the /tmp/kubeconfig-<name> naming but have no
    // matching k3d container).
    if (match && await this.dockerContainerExists(`k3d-${match[1] ?? 'unknown'}-server-0`)) {
      const clusterName = match[1] ?? 'unknown';
      const containerName = `k3d-${clusterName}-server-0`;

      const cleanArgs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === undefined) continue;
        if (arg === '--context') {
          i++; // skip context name
        } else {
          cleanArgs.push(arg);
        }
      }

      child = spawn('docker', ['exec', '-i', containerName, 'kubectl', ...cleanArgs]);
    } else {
      child = spawn(path.join(BIN_DIR, 'kubectl'), args, {
        env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
      });
    }

    this.activeStreams.set(resourceId, child);
    child.stdout.on('data', (data) => io.to(room).emit('kube-log', data.toString()));
    child.stderr.on('data', (data) => io.to(room).emit('kube-log', data.toString()));
    child.on('error', (err) => {
      console.warn(`[streamLogs] ${resourceId}: ${err.message}`);
      this.activeStreams.delete(resourceId);
    });
    child.on('close', () => this.activeStreams.delete(resourceId));
  }

  stopStream(resourceId: string) {
    const active = this.activeStreams.get(resourceId);
    if (active) {
      active.kill();
      this.activeStreams.delete(resourceId);
    }
  }

  /**
   * Verifies the host has the required GPU container toolkit installed.
   * Throws a descriptive error if the toolkit is missing.
   */
  async checkGpuToolkit(vendor: 'nvidia' | 'amd'): Promise<void> {
    if (vendor === 'nvidia') {
      // Check nvidia-smi exists
      let nvidiaSmiOk = false;
      try {
        await execAsync('nvidia-smi');
        nvidiaSmiOk = true;
      } catch {
        throw new Error(
          'NVIDIA GPU toolkit not found on host. Install the NVIDIA driver and NVIDIA Container Toolkit ' +
          'before deploying vLLM with NVIDIA GPUs. See README.md for setup instructions.'
        );
      }

      // Check Docker NVIDIA runtime is configured
      let dockerInfo = '';
      try {
        const { stdout } = await execAsync('docker info');
        dockerInfo = stdout;
      } catch {
        throw new Error(
          'Docker is not running. Start Docker before deploying GPU workloads.'
        );
      }

      if (!dockerInfo.includes('nvidia')) {
        throw new Error(
          'NVIDIA Container Toolkit is not configured for Docker. Docker cannot pass GPUs to containers. ' +
          'Install the NVIDIA Container Toolkit and run: sudo nvidia-ctk runtime configure --runtime=docker, ' +
          'then restart Docker. See README.md for setup instructions.'
        );
      }

      if (!nvidiaSmiOk) {
        throw new Error(
          'NVIDIA driver not found. Install the NVIDIA driver before deploying vLLM with NVIDIA GPUs.'
        );
      }
    } else {
      // AMD: check rocminfo exists
      let rocminfoOk = false;
      try {
        await execAsync('rocminfo');
        rocminfoOk = true;
      } catch {
        throw new Error(
          'AMD ROCm toolkit not found on host. Install the ROCm driver and ROCm Container Toolkit ' +
          'before deploying vLLM with AMD GPUs. See README.md for setup instructions.'
        );
      }

      // Check Docker ROCm runtime is configured
      let dockerInfo = '';
      try {
        const { stdout } = await execAsync('docker info');
        dockerInfo = stdout;
      } catch {
        throw new Error(
          'Docker is not running. Start Docker before deploying GPU workloads.'
        );
      }

      if (!dockerInfo.includes('rocm') && !dockerInfo.includes('hip')) {
        throw new Error(
          'ROCm Container Toolkit is not configured for Docker. Docker cannot pass AMD GPUs to containers. ' +
          'Install the ROCm Container Toolkit and configure Docker, then restart Docker. ' +
          'See README.md for setup instructions.'
        );
      }

      if (!rocminfoOk) {
        throw new Error(
          'AMD ROCm driver not found. Install the ROCm driver before deploying vLLM with AMD GPUs.'
        );
      }
    }
  }

  /**
   * Installs the GPU device plugin DaemonSet into the cluster.
   * Idempotent: skips if the DaemonSet already exists.
   * Waits for the plugin pod to become ready (up to 60s).
   */
  async installGpuDevicePlugin(vendor: 'nvidia' | 'amd', kubeconfigPath: string): Promise<void> {
    const manifestPath = path.join(PROJECT_ROOT, 'k8s', 'gpu-device-plugin', `${vendor}.yaml`);
    const dsName = vendor === 'nvidia' ? 'nvidia-device-plugin-daemonset' : 'amdgpu-device-plugin-daemonset';
    const dsLabel = vendor === 'nvidia' ? 'name=nvidia-device-plugin-ds' : 'name=amdgpu-dp-ds';

    // NVIDIA only: point pods at the `nvidia` containerd runtime k3s already auto-registers on
    // hosts with nvidia-container-runtime installed (confirmed via its own startup log — no
    // config needed from us). AMD doesn't need this — ROCm GPU access is plain device-file
    // mounting (/dev/kfd, /dev/dri), no custom OCI runtime injection involved. Idempotent.
    if (vendor === 'nvidia') {
      const runtimeClassPath = path.join(PROJECT_ROOT, 'k8s', 'gpu-device-plugin', 'nvidia-runtimeclass.yaml');
      try {
        await execAsync(
          `${escapeShellArg(path.join(BIN_DIR, 'kubectl'))} apply -f ${escapeShellArg(runtimeClassPath)}`,
          { env: { ...process.env, KUBECONFIG: kubeconfigPath } },
        );
      } catch (err: any) {
        console.warn(`[InfrastructureService] Failed to apply nvidia RuntimeClass: ${err.message}`);
      }
    }

    // Check if DaemonSet already exists
    try {
      await this.runKubectl(['get', 'daemonset', dsName, '-n', 'kube-system'], kubeconfigPath);
      console.log(`[InfrastructureService] GPU device plugin (${vendor}) DaemonSet already exists, skipping install.`);
    } catch {
      // DaemonSet doesn't exist, install it
      console.log(`[InfrastructureService] Installing GPU device plugin (${vendor}) DaemonSet...`);
      const escapedArgs = ['apply', '-f', manifestPath].map(escapeShellArg).join(' ');
      const { stdout } = await execAsync(
        `${escapeShellArg(path.join(BIN_DIR, 'kubectl'))} ${escapedArgs}`,
        {
          env: { ...process.env, KUBECONFIG: kubeconfigPath }
        }
      );
      console.log(`[InfrastructureService] GPU device plugin (${vendor}) applied: ${stdout.trim()}`);
    }

    // Wait for plugin pod to become ready (up to 60s)
    console.log(`[InfrastructureService] Waiting for GPU device plugin (${vendor}) pod to become ready...`);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const podsJson = await this.runKubectl(
          ['get', 'pods', '-n', 'kube-system', '-l', dsLabel, '-o', 'json'],
          kubeconfigPath
        );
        const podsObj = JSON.parse(podsJson);
        const pods = podsObj.items || [];
        const hasReadyPod = pods.some((pod: any) =>
          pod.status?.phase === 'Running' &&
          pod.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')
        );
        if (hasReadyPod) {
          ready = true;
          break;
        }
      } catch {
        // Pod not found yet, continue polling
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!ready) {
      throw new Error(
        `GPU device plugin (${vendor}) DaemonSet failed to become ready within 60s. ` +
        `Check plugin pod logs: kubectl get pods -n kube-system -l ${dsLabel} ` +
        `and kubectl logs -n kube-system -l ${dsLabel}`
      );
    }

    console.log(`[InfrastructureService] GPU device plugin (${vendor}) is ready.`);
  }

  private async runCommand(cmd: string, args: string[], logId: string, options: ExecuteOptions = {}) {
    const env = {
      ...process.env,
      ...options.env,
      PATH: `${process.env.PATH}:${BIN_DIR}`,
      CDKTF_DISABLE_PLUGIN_CACHE_ENV: 'true',
    };
    delete (env as any).TF_PLUGIN_CACHE_DIR;
    const logFile = options.logFile || this.getLogPath(logId);
    const cwd = (options.env as any)?.CD_DIR || CDKTF_DIR;
    await fs.mkdir(LOG_DIR, { recursive: true });

    console.log(`[InfrastructureService] Spawning cmd=${cmd} args=${JSON.stringify(args)} with env TF_PLUGIN_CACHE_DIR=${env.TF_PLUGIN_CACHE_DIR}`);

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, env });
      let stdout = '', stderr = '';
      let timedOut = false;

      const broadcast = (data: string) => {
        if (options.io && options.resourceId) {
            options.io.to(options.resourceId).emit('log', data);
        }
      };

      if (options.timeout) {
        const timer = setTimeout(() => {
          timedOut = true;
          const timeoutMsg = `\n--- COMMAND TIMED OUT after ${options.timeout}ms ---\n`;
          broadcast(timeoutMsg);
          fs.appendFile(logFile, timeoutMsg).catch(console.error);
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 5000);
          reject({ message: `Command timed out: ${cmd} after ${options.timeout}ms`, stdout, stderr, logFile });
        }, options.timeout);

        child.on('close', () => clearTimeout(timer));
        child.on('error', () => clearTimeout(timer));
      }

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        broadcast(chunk);
        fs.appendFile(logFile, chunk).catch(console.error);
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        broadcast(chunk);
        fs.appendFile(logFile, chunk).catch(console.error);
      });

      child.on('close', (code) => {
        if (timedOut) return;
        if (code === 0) {
            resolve({ stdout, logFile });
        } else {
            const errorMsg = `\n--- EXECUTION FAILED (Exit Code ${code}) ---\n`;
            broadcast(errorMsg);
            fs.appendFile(logFile, errorMsg).catch(console.error);
            reject({ message: `Command failed: ${cmd}`, stdout, stderr, logFile });
        }
      });
      child.on('error', (err) => {
        if (timedOut) return;
          const errorMsg = `\n--- SPAWN ERROR: ${err.message} ---\n`;
          broadcast(errorMsg);
          reject(err);
      });
    });
  }
}
