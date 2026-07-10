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

export interface ExecuteOptions {
  env?: Record<string, string> | undefined;
  logFile?: string | undefined;
  resourceId?: string | undefined; 
  io?: SocketServer | undefined;
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

  async importImage(clusterName: string, imageTag: string, options: ExecuteOptions = {}) {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['image', 'import', imageTag, '-c', clusterName], imageTag, options);
  }

  async runKubectl(args: string[], kubeconfig?: string) {
    const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
    if (match) {
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
      
      const escapedArgs = cleanArgs.map(escapeShellArg).join(' ');
      const { stdout } = await execAsync(`docker exec ${containerName} kubectl ${escapedArgs}`);
      return stdout;
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
      '--network', 'host',
      '--wait',
      '--k3s-arg', `--resolv-conf=${resolvConfPath}@server:*`
    ];

    if (resolvConfPath !== '/etc/resolv.conf') {
      args.push('--volume', `${resolvConfPath}:${resolvConfPath}@server:*`);
    }

    return this.runCommand(path.join(BIN_DIR, 'k3d'), args, name, {
      ...options,
      env: {
        ...options.env,
        K3D_FIX_DNS: '0'
      }
    });
  }

  async deleteLocalCluster(name: string, options: ExecuteOptions = {}) {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['cluster', 'delete', name], name, options);
  }

  async streamLogs(resourceId: string, args: string[], io: SocketServer, room: string, kubeconfig?: string) {
    this.stopStream(resourceId);
    
    const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
    let child;
    if (match) {
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
    child.on('close', () => this.activeStreams.delete(resourceId));
  }

  stopStream(resourceId: string) {
    const active = this.activeStreams.get(resourceId);
    if (active) {
      active.kill();
      this.activeStreams.delete(resourceId);
    }
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

      const broadcast = (data: string) => {
        if (options.io && options.resourceId) {
            options.io.to(options.resourceId).emit('log', data);
        }
      };

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
          const errorMsg = `\n--- SPAWN ERROR: ${err.message} ---\n`;
          broadcast(errorMsg);
          reject(err);
      });
    });
  }
}
