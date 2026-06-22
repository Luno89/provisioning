import { spawn, ChildProcess, exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { Server as SocketServer } from 'socket.io';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CDKTF_DIR = path.join(__dirname, '../../../../packages/cdktf-infra');
const LOG_DIR = path.join(__dirname, '../../data/logs');
const BIN_DIR = '/home/luno/Code/provisioning/bin';

export interface ExecuteOptions {
  env?: Record<string, string>;
  onLog?: (data: string) => void;
  logFile?: string;
  resourceId?: string; 
  io?: SocketServer;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  logFile: string;
}

export class Executor {
  private activeStreams: Map<string, ChildProcess> = new Map();

  getLogPath(logId: string) {
    return path.join(LOG_DIR, `${logId}-${Date.now()}.log`);
  }

  async deploy(stackName: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    return this.runCommand('npx', ['cdktf', 'deploy', stackName, '--auto-approve'], stackName, options);
  }

  async destroy(stackName: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    return this.runCommand('npx', ['cdktf', 'destroy', stackName, '--auto-approve'], stackName, options);
  }

  async createLocalCluster(name: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['cluster', 'create', name, '--wait', '-p', '8069:8069@loadbalancer'], name, options);
  }

  async deleteLocalCluster(name: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['cluster', 'delete', name], name, options);
  }

  async listHelmReleases(kubeconfig: string, context?: string) {
    const contextFlag = context ? `--kube-context ${context}` : '';
    const { stdout } = await execAsync(`${path.join(BIN_DIR, 'helm')} list -A ${contextFlag} -o json`, {
      env: { ...process.env, KUBECONFIG: kubeconfig }
    });
    return JSON.parse(stdout);
  }

  async getHelmStatus(kubeconfig: string, releaseName: string, namespace: string, context?: string) {
    const contextFlag = context ? `--kube-context ${context}` : '';
    const { stdout } = await execAsync(`${path.join(BIN_DIR, 'helm')} status ${releaseName} -n ${namespace} ${contextFlag}`, {
      env: { ...process.env, KUBECONFIG: kubeconfig }
    });
    return stdout;
  }

  async getDiagnostics(kubeconfig: string, namespace: string, context?: string) {
    const contextFlag = context ? `--context ${context}` : '';
    const { stdout: events } = await execAsync(`${path.join(BIN_DIR, 'kubectl')} get events -n ${namespace} ${contextFlag} --sort-by='.lastTimestamp' -o wide`, {
      env: { ...process.env, KUBECONFIG: kubeconfig }
    });
    const { stdout: pods } = await execAsync(`${path.join(BIN_DIR, 'kubectl')} get pods -n ${namespace} ${contextFlag} -o wide`, {
      env: { ...process.env, KUBECONFIG: kubeconfig }
    });
    return `--- POD STATUS ---\n${pods}\n\n--- RECENT EVENTS ---\n${events}`;
  }

  async listPods(kubeconfig: string, namespace?: string, context?: string) {
    const nsFlag = namespace === '--all-namespaces' ? '--all-namespaces' : `-n ${namespace || 'default'}`;
    const contextFlag = context ? `--context ${context}` : '';
    const command = `${path.join(BIN_DIR, 'kubectl')} get pods ${nsFlag} ${contextFlag} -o json`;
    
    const { stdout } = await execAsync(command, {
      env: { ...process.env, KUBECONFIG: kubeconfig }
    });
    return JSON.parse(stdout).items;
  }

  async streamPodLogs(resourceId: string, namespace: string, podName: string, io: SocketServer, context?: string) {
    this.stopKubeStream(resourceId);
    
    const args = ['logs', '-n', namespace, podName, '--tail=100', '-f'];
    if (context) args.push('--context', context);

    const child = spawn(path.join(BIN_DIR, 'kubectl'), args, {
      env: { ...process.env, KUBECONFIG: '/home/luno/.kube/config' }
    });

    this.activeStreams.set(resourceId, child);
    child.stdout.on('data', (data) => io.to(`${resourceId}-kube`).emit('kube-log', data.toString()));
    child.stderr.on('data', (data) => io.to(`${resourceId}-kube`).emit('kube-log', data.toString()));
    child.on('close', () => this.activeStreams.delete(resourceId));
  }

  stopKubeStream(resourceId: string) {
    const active = this.activeStreams.get(resourceId);
    if (active) {
      active.kill();
      this.activeStreams.delete(resourceId);
    }
  }

  private async runCommand(cmd: string, args: string[], logId: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const env = { ...process.env, ...options.env, PATH: `${process.env.PATH}:${BIN_DIR}` };
    const logFile = options.logFile || this.getLogPath(logId);
    await fs.mkdir(LOG_DIR, { recursive: true });

    return new Promise<ExecuteResult>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: CDKTF_DIR, env });
      let stdout = '', stderr = '';

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (options.io && options.resourceId) options.io.to(options.resourceId).emit('log', chunk);
        fs.appendFile(logFile, chunk).catch(console.error);
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (options.io && options.resourceId) options.io.to(options.resourceId).emit('log', chunk);
        fs.appendFile(logFile, chunk).catch(console.error);
      });

      child.on('close', (code) => {
        const result = { stdout, stderr, logFile };
        code === 0 ? resolve(result) : reject({ message: `Command failed: ${cmd}`, ...result });
      });
      child.on('error', reject);
    });
  }
}
