import { spawn, ChildProcess, exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
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
  env?: Record<string, string>;
  logFile?: string;
  resourceId?: string; 
  io?: SocketServer;
}

/**
 * Service to handle low-level infrastructure commands.
 */
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
      const clusterName = match[1];
      const containerName = `k3d-${clusterName}-server-0`;
      
      const cleanArgs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--context') {
          i++; // skip context name
        } else {
          cleanArgs.push(args[i]);
        }
      }
      
      const { stdout } = await execAsync(`docker exec ${containerName} kubectl ${cleanArgs.join(' ')}`);
      return stdout;
    }

    const { stdout } = await execAsync(`${path.join(BIN_DIR, 'kubectl')} ${args.join(' ')}`, {
      env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
    });
    return stdout;
  }

  async runHelm(args: string[], kubeconfig?: string) {
    const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
    if (match) {
      const clusterName = match[1];
      const containerName = `k3d-${clusterName}-server-0`;
      
      // Ensure helm binary exists in the container
      try {
        await execAsync(`docker exec ${containerName} ls /bin/helm`);
      } catch {
        // If not, copy it from host bin/helm
        try {
          await execAsync(`docker cp ${path.join(BIN_DIR, 'helm')} ${containerName}:/bin/helm`);
        } catch (err: any) {
          console.error(`Failed to copy helm to container ${containerName}: ${err.message}`);
        }
      }

      const cleanArgs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--kube-context') {
          i++; // skip context name
        } else {
          cleanArgs.push(args[i]);
        }
      }

      const { stdout } = await execAsync(`docker exec -e KUBECONFIG=/etc/rancher/k3s/k3s.yaml ${containerName} helm ${cleanArgs.join(' ')}`);
      return stdout;
    }

    const { stdout } = await execAsync(`${path.join(BIN_DIR, 'helm')} ${args.join(' ')}`, {
      env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
    });
    return stdout;
  }

  async getKubeconfig(name: string) {
    const { stdout } = await execAsync(`${path.join(BIN_DIR, 'k3d')} kubeconfig get ${name}`);
    return stdout;
  }

  async createLocalCluster(name: string, options: ExecuteOptions = {}) {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['cluster', 'create', name, '--wait', '-p', '8069:8069@loadbalancer'], name, options);
  }

  async deleteLocalCluster(name: string, options: ExecuteOptions = {}) {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['cluster', 'delete', name], name, options);
  }

  async streamLogs(resourceId: string, args: string[], io: SocketServer, room: string, kubeconfig?: string) {
    this.stopStream(resourceId);
    
    const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
    let child;
    if (match) {
      const clusterName = match[1];
      const containerName = `k3d-${clusterName}-server-0`;
      
      const cleanArgs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--context') {
          i++; // skip context name
        } else {
          cleanArgs.push(args[i]);
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
    const env = { ...process.env, ...options.env, PATH: `${process.env.PATH}:${BIN_DIR}` };
    const logFile = options.logFile || this.getLogPath(logId);
    const cwd = (options.env as any)?.CD_DIR || CDKTF_DIR;
    await fs.mkdir(LOG_DIR, { recursive: true });

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
