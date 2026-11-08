import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { Server as SocketServer } from 'socket.io';

import os from 'os';
import { CommandFailedError } from '../../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import { cdktfStateEnv, stateFilesOf, stateMove, terraformCliConfig, terraformStateFrom, type TerraformStateHome } from '../lib/terraform-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const CDKTF_DIR = path.join(PROJECT_ROOT, 'packages/cdktf-infra');
export const LOG_DIR = path.join(PROJECT_ROOT, 'apps/backend/data/logs');
const STATE_DIR = path.join(PROJECT_ROOT, 'apps/backend/data/terraform');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const MIRROR_DIR = path.join(BIN_DIR, 'terraform-providers');

export interface ExecuteOptions {
  env?: Record<string, string> | undefined;
  logFile?: string | undefined;
  resourceId?: string | undefined;
  io?: SocketServer | undefined;
  outputsFile?: string | undefined;
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

  constructor(private readonly terraform: TerraformPlaces = { cdktfDir: CDKTF_DIR, stateDir: STATE_DIR }) {}

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
