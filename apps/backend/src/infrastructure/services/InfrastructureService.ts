import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { Server as SocketServer } from 'socket.io';

import os from 'os';
import { CommandFailedError } from '../../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import { execShell, type Shell } from '../lib/shell.js';
import { installGpuDevicePlugin } from './gpu-runtime.js';
import { cdktfStateEnv, stateFilesOf, stateMove, terraformCliConfig, terraformStateFrom, type TerraformStateHome } from '../lib/terraform-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const CDKTF_DIR = path.join(PROJECT_ROOT, 'packages/cdktf-infra');
export const LOG_DIR = path.join(PROJECT_ROOT, 'apps/backend/data/logs');
const STATE_DIR = path.join(PROJECT_ROOT, 'apps/backend/data/terraform');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const MIRROR_DIR = path.join(BIN_DIR, 'terraform-providers');
export const K3D_KUBECONFIG = path.join(os.homedir(), '.kube/config');
const K3D_STORAGE_ROOT = path.join(PROJECT_ROOT, '.k3d-storage');
const VLLM_CACHE_HOST_DIR = path.join(PROJECT_ROOT, '.vllm-model-cache');
const TABBYAPI_CACHE_HOST_DIR = path.join(PROJECT_ROOT, '.tabbyapi-model-cache');

export interface ExecuteOptions {
  env?: Record<string, string> | undefined;
  logFile?: string | undefined;
  resourceId?: string | undefined;
  io?: SocketServer | undefined;
  outputsFile?: string | undefined;
}

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export interface TerraformPlaces {
  cdktfDir: string;
  stateDir: string;
  home?: TerraformStateHome | undefined;
  mirrorDir?: string | undefined;
  runsDir?: string | undefined;
}

async function adoptStateFromBefore(stackName: string, places: TerraformPlaces): Promise<void> {
  await fs.mkdir(places.stateDir, { recursive: true });
  for (const file of stateFilesOf(stackName)) {
    const before = path.join(places.cdktfDir, file);
    const now = path.join(places.stateDir, file);
    if (!existsSync(before) || existsSync(now)) continue;
    await fs.copyFile(before, now);
    await fs.unlink(before).catch(ignore('a checkout mounted read-only keeps its copy; the state folder now holds the one Terraform uses'));
  }
}

const sharedOutputGone = new Map<string, Promise<void>>();
const dropSharedOutput = (stateDir: string): Promise<void> => {
  const gone = sharedOutputGone.get(stateDir) ?? fs.rm(path.join(stateDir, 'cdktf.out'), { recursive: true, force: true });
  sharedOutputGone.set(stateDir, gone);
  return gone;
};

function commandEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    PATH: `${process.env.PATH}:${BIN_DIR}`,
    CDKTF_DISABLE_PLUGIN_CACHE_ENV: 'true',
  };
  delete env.TF_PLUGIN_CACHE_DIR;
  return env;
}

function terraformQuietly(args: string[], cwd: string, extra: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('terraform', args, { cwd, env: { ...commandEnv(extra), TF_IN_AUTOMATION: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { said = `${said}${chunk.toString()}`.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`terraform ${args.slice(0, 2).join(' ')} ended with ${code}: ${said.trim()}`))));
  });
}

export class InfrastructureService {

  constructor(private readonly shell: Shell = execShell, private readonly terraform: TerraformPlaces = { cdktfDir: CDKTF_DIR, stateDir: STATE_DIR }) {}

  getLogPath(logId: string) {
    return path.join(LOG_DIR, `${logId}-${Date.now()}.log`);
  }

  async deploy(stackName: string, options: ExecuteOptions = {}) {
    const outputs = options.outputsFile ? ['--outputs-file', options.outputsFile, '--outputs-file-include-sensitive-outputs'] : [];
    return this.cdktf('deploy', stackName, outputs, options);
  }

  async destroy(stackName: string, options: ExecuteOptions = {}) {
    return this.cdktf('destroy', stackName, [], options);
  }

  private async cdktf(verb: 'deploy' | 'destroy', stackName: string, extra: string[], options: ExecuteOptions) {
    const home = this.terraform.home ?? terraformStateFrom(process.env, this.terraform.stateDir);
    await adoptStateFromBefore(stackName, this.terraform);
    await dropSharedOutput(this.terraform.stateDir);
    const run = await fs.mkdtemp(path.join(this.terraform.runsDir ?? os.tmpdir(), 'koala-cdktf-'));
    try {
      const output = path.join(run, 'cdktf.out');
      const env = { ...options.env, ...cdktfStateEnv(home), ...(await this.providerConfig(run)) };
      const runOptions = { ...options, env };
      const kept = path.join(this.terraform.stateDir, stateFilesOf(stackName)[0]!);
      const moving = home.kind === 'kubernetes' && existsSync(kept);
      if (moving) {
        await this.runCommand('npx', ['cdktf', 'synth', '--output', output], stackName, runOptions);
        await this.moveStateIntoCluster(stackName, kept, path.join(output, 'stacks', stackName), env, options.logFile);
      }
      return await this.runCommand('npx', ['cdktf', verb, stackName, '--auto-approve', '--output', output, ...(moving ? ['--skip-synth'] : []), ...extra], stackName, runOptions);
    } finally {
      await fs.rm(run, { recursive: true, force: true });
    }
  }

  private async providerConfig(run: string): Promise<Record<string, string>> {
    const mirror = this.terraform.mirrorDir ?? MIRROR_DIR;
    if (!existsSync(mirror)) return {};
    const file = path.join(run, 'terraform.rc');
    await fs.writeFile(file, terraformCliConfig(mirror));
    return { TF_CLI_CONFIG_FILE: file };
  }

  private async moveStateIntoCluster(stackName: string, kept: string, stackDir: string, env: Record<string, string>, logFile: string | undefined): Promise<void> {
    if (logFile) await fs.appendFile(logFile, `[terraform] moving the state of ${stackName} from the data folder into the cluster\n`).catch(ignore('the log only shows progress, and the move goes on without it'));
    const local = await fs.readFile(kept, 'utf8');
    await terraformQuietly(['init', '-input=false', '-no-color'], stackDir, env);
    const move = stateMove(stackName, local, await terraformQuietly(['state', 'pull'], stackDir, env));
    if (move.step === 'refuse') throw new Error(move.reason);
    if (move.step === 'push') {
      await terraformQuietly(['state', 'push', '-force', kept], stackDir, env);
      const landed = stateMove(stackName, local, await terraformQuietly(['state', 'pull'], stackDir, env));
      if (landed.step !== 'forget') throw new Error(`the state of ${stackName} was pushed into the cluster but is not there; it stays in the data folder`);
    }
    for (const file of stateFilesOf(stackName)) await fs.rm(path.join(this.terraform.stateDir, file), { force: true });
  }

  async buildImage(tag: string, dockerfile: string, context: string, options: ExecuteOptions = {}) {
    const dockerfilePath = path.join(context, 'Dockerfile');
    await fs.writeFile(dockerfilePath, dockerfile);
    return this.runCommand('docker', ['build', '-t', tag, '.'], tag, { ...options, env: { ...options.env, CD_DIR: context } });
  }

  private async dockerContainerExists(containerName: string): Promise<boolean> {
    try {
      await this.shell(`docker inspect ${escapeShellArg(containerName)}`);
      return true;
    } catch {
      return false;
    }
  }

  async runKubectl(args: string[], kubeconfig: string) {
    const match = kubeconfig.match(/\/tmp\/kubeconfig-(.+)$/);
    if (match) {
      const clusterName = match[1] ?? 'unknown';
      const containerName = `k3d-${clusterName}-server-0`;

      if (await this.dockerContainerExists(containerName)) {
        const cleanArgs: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === undefined) continue;
          if (arg === '--context') {
            i++;
          } else {
            cleanArgs.push(arg);
          }
        }

        const escapedArgs = cleanArgs.map(escapeShellArg).join(' ');
        const { stdout } = await this.shell(`docker exec ${containerName} kubectl ${escapedArgs}`);
        return stdout;
      }
    }

    const escapedArgs = args.map(escapeShellArg).join(' ');
    const { stdout } = await this.shell(`${escapeShellArg(path.join(BIN_DIR, 'kubectl'))} ${escapedArgs}`, {
      env: { ...process.env, KUBECONFIG: kubeconfig }
    });
    return stdout;
  }

  async runHelm(args: string[], kubeconfig: string) {
    const match = kubeconfig.match(/\/tmp\/kubeconfig-(.+)$/);
    if (match) {
      const clusterName = match[1] ?? 'unknown';
      const containerName = `k3d-${clusterName}-server-0`;

      if (await this.dockerContainerExists(containerName)) {
        try {
          await this.shell(`docker exec ${containerName} ls /bin/helm`);
        } catch {
          try {
            const hostHelmPath = existsSync(path.join(BIN_DIR, 'helm-linux'))
              ? path.join(BIN_DIR, 'helm-linux')
              : path.join(BIN_DIR, 'helm');
            await this.shell(`docker cp ${escapeShellArg(hostHelmPath)} ${containerName}:/bin/helm`);
            await this.shell(`docker exec ${containerName} chmod +x /bin/helm`);
          } catch (err) {
            console.error(`Failed to copy helm to container ${containerName}: ${(err as Error).message}`);
          }
        }

        const cleanArgs = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === undefined) continue;
          if (arg === '--kube-context') {
            i++;
          } else {
            cleanArgs.push(arg);
          }
        }

        const escapedArgs = cleanArgs.map(escapeShellArg).join(' ');
        const { stdout } = await this.shell(`docker exec -e KUBECONFIG=/etc/rancher/k3s/k3s.yaml ${containerName} helm ${escapedArgs}`);
        return stdout;
      }
    }

    const escapedArgs = args.map(escapeShellArg).join(' ');
    const { stdout } = await this.shell(`${escapeShellArg(path.join(BIN_DIR, 'helm'))} ${escapedArgs}`, {
      env: { ...process.env, KUBECONFIG: kubeconfig }
    });
    return stdout;
  }

  async getKubeconfig(name: string) {
    const { stdout } = await this.shell(`${path.join(BIN_DIR, 'k3d')} kubeconfig get ${name}`);
    return stdout;
  }

  async getManagementClusterKubeconfig(physicalName: string): Promise<string> {
    const managementContext = 'k3d-provisioning-lunorica';
    const { stdout } = await this.shell(
      `${path.join(BIN_DIR, 'kubectl')} config view --minify --raw --context=${managementContext} --kubeconfig=${K3D_KUBECONFIG}`,
    );
    if (!stdout.includes(managementContext)) {
      throw new Error(
        `Management cluster context "${managementContext}" not found in ${K3D_KUBECONFIG}. ` +
        `Is the management cluster running? (Linux: sudo systemctl start k3s-provisioning-lunorica, or re-run npm run dev)`,
      );
    }
    return stdout.split(managementContext).join(`k3d-${physicalName}`);
  }

  async listLocalClusters(): Promise<string[]> {
    try {
      const { stdout } = await this.shell(`${path.join(BIN_DIR, 'k3d')} cluster list --no-headers`);
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
    } catch (err) {
      console.warn(`[InfrastructureService] Failed to check existing clusters: ${(err as Error).message}`);
    }

    let resolvConfPath = '/etc/resolv.conf';
    if (existsSync('/run/systemd/resolve/resolv.conf')) {
      resolvConfPath = '/run/systemd/resolve/resolv.conf';
    } else if (existsSync('/var/run/systemd/resolve/resolv.conf')) {
      resolvConfPath = '/var/run/systemd/resolve/resolv.conf';
    }

    const args = [
      'cluster', 'create', name,
      '--wait',
      '--k3s-arg', `--resolv-conf=${resolvConfPath}@server:*`
    ];

    if (resolvConfPath !== '/etc/resolv.conf') {
      args.push('--volume', `${resolvConfPath}:${resolvConfPath}@server:*`);
    }

    const hostStorageDir = path.join(K3D_STORAGE_ROOT, name);
    await fs.mkdir(hostStorageDir, { recursive: true });
    args.push('--volume', `${hostStorageDir}:/var/lib/rancher/k3s/storage@server:*;agent:*`);

    await fs.mkdir(VLLM_CACHE_HOST_DIR, { recursive: true });
    args.push('--volume', `${VLLM_CACHE_HOST_DIR}:/var/lib/rancher/vllm-model-cache@server:*;agent:*`);

    await fs.mkdir(TABBYAPI_CACHE_HOST_DIR, { recursive: true });
    args.push('--volume', `${TABBYAPI_CACHE_HOST_DIR}:/var/lib/rancher/tabbyapi-model-cache@server:*;agent:*`);

    await this.runCommand(path.join(BIN_DIR, 'k3d'), args, name, {
      ...options,
      env: {
        ...options.env,
        K3D_FIX_DNS: '0'
      }
    });

    return { stdout: `Cluster ${name} created.`, logFile: this.getLogPath(name) };
  }

  async deleteLocalCluster(name: string, options: ExecuteOptions = {}) {
    return this.runCommand(path.join(BIN_DIR, 'k3d'), ['cluster', 'delete', name], name, options);
  }

  async checkGpuToolkit(vendor: 'nvidia' | 'amd'): Promise<void> {
    if (vendor === 'nvidia') {
      let nvidiaSmiOk = false;
      try {
        await this.shell('nvidia-smi');
        nvidiaSmiOk = true;
      } catch {
        throw new Error(
          'NVIDIA GPU toolkit not found on host. Install the NVIDIA driver and NVIDIA Container Toolkit ' +
          'before deploying vLLM with NVIDIA GPUs. See README.md for setup instructions.'
        );
      }

      let dockerInfo = '';
      try {
        const { stdout } = await this.shell('docker info');
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
      let rocminfoOk = false;
      try {
        await this.shell('rocminfo');
        rocminfoOk = true;
      } catch {
        throw new Error(
          'AMD ROCm toolkit not found on host. Install the ROCm driver and ROCm Container Toolkit ' +
          'before deploying vLLM with AMD GPUs. See README.md for setup instructions.'
        );
      }

      let dockerInfo = '';
      try {
        const { stdout } = await this.shell('docker info');
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

  async installGpuDevicePlugin(vendor: 'nvidia' | 'amd', kubeconfigPath: string): Promise<void> {
    await installGpuDevicePlugin((args) => this.runKubectl(args, kubeconfigPath), vendor);
  }

  async runCommand(cmd: string, args: string[], logId: string, options: ExecuteOptions = {}): Promise<{ stdout: string; logFile: string }> {
    const env = commandEnv(options.env);
    const logFile = options.logFile || this.getLogPath(logId);
    const cwd = options.env?.CD_DIR || this.terraform.cdktfDir;
    await fs.mkdir(LOG_DIR, { recursive: true });

    console.log(`[InfrastructureService] Spawning cmd=${cmd} args=${JSON.stringify(args)} (TF_PLUGIN_CACHE_DIR deliberately unset — see the delete above)`);

    return new Promise<{ stdout: string; logFile: string }>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, env });
      let stdout = '', stderr = '';
      const broadcast = (data: string) => {
        if (options.io && options.resourceId) {
            options.io.to(options.resourceId).emit('log', data);
        }
      };

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        broadcast(chunk);
        fs.appendFile(logFile, chunk).catch(console.error);
      });

      child.stderr.on('data', (data: Buffer) => {
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
            reject(new CommandFailedError(cmd, code, stdout, stderr, logFile));
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
