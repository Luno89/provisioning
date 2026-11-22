import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { Server as SocketServer } from 'socket.io';

import os from 'os';
import { CommandFailedError, DOCKER_CLIENT, nodeRunner, passedOn, type Processes, type Streams } from '../../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import { cdktfStateEnv, stateFilesOf, stateHomeIn, stateMove, terraformCliConfig, type TerraformStateHome, type TerraformStateKind } from '../lib/terraform-state.js';
import type { StateLocks } from './StateLocks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const CDKTF_DIR = path.join(PROJECT_ROOT, 'packages/cdktf-infra');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const MIRROR_DIR = path.join(BIN_DIR, 'terraform-providers');

export interface ExecuteOptions {
  env?: Record<string, string> | undefined;
  logFile?: string | undefined;
  resourceId?: string | undefined;
  io?: SocketServer | undefined;
  outputsFile?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface TerraformPlaces {
  cdktfDir: string;
  stateDir: string;
  logDir: string;
  home: TerraformStateHome | { off: string };
  mirrorDir?: string | undefined;
  runsDir?: string | undefined;
  chartSources?: string | undefined;
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

export class TerraformStopped extends Error {
  constructor(readonly why: string) {
    super(`Terraform was stopped: ${why}`);
    this.name = 'TerraformStopped';
  }
}

const reasonOf = (reason: unknown): string => (reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'it was stopped');
const stoppedBy = (signal: AbortSignal): TerraformStopped => new TerraformStopped(reasonOf(signal.reason));

const applying = new Map<string, number>();

const sharedOutputGone = new Map<string, Promise<void>>();
const dropSharedOutput = (stateDir: string): Promise<void> => {
  const gone = sharedOutputGone.get(stateDir) ?? fs.rm(path.join(stateDir, 'cdktf.out'), { recursive: true, force: true });
  sharedOutputGone.set(stateDir, gone);
  return gone;
};

function commandEnv(extra: Record<string, string> | undefined): Record<string, string> {
  return {
    ...extra,
    PATH: [passedOn(['PATH']).PATH, BIN_DIR].filter(Boolean).join(':'),
    CDKTF_DISABLE_PLUGIN_CACHE_ENV: 'true',
  };
}

const SAID_KEPT = 4000;

async function terraformQuietly(processes: Processes, args: string[], cwd: string, extra: Record<string, string>): Promise<string> {
  const ran = await processes.run({ command: 'terraform', args, cwd, env: { ...commandEnv(extra), TF_IN_AUTOMATION: 'true' } });
  if (ran.code !== 0) throw new Error(`terraform ${args.slice(0, 2).join(' ')} ended with ${ran.signal ?? ran.code}: ${ran.stderr.slice(-SAID_KEPT).trim()}`);
  return ran.stdout;
}

export const terraformPlacesFor = (state: TerraformStateKind | { off: string }, dataDir: string, chartSources?: string): TerraformPlaces => {
  const stateDir = path.join(dataDir, 'terraform');
  return { cdktfDir: CDKTF_DIR, stateDir, logDir: path.join(dataDir, 'logs'), home: 'off' in state ? state : stateHomeIn(state, stateDir), ...(chartSources ? { chartSources } : {}) };
};

export class InfrastructureService {

  constructor(private readonly terraform: TerraformPlaces, private readonly processes: Processes & Streams = nodeRunner, private readonly locks?: StateLocks) {}

  getLogPath(logId: string) {
    return path.join(this.terraform.logDir, `${logId}-${Date.now()}.log`);
  }

  async deploy(stackName: string, options: ExecuteOptions = {}) {
    const outputs = options.outputsFile ? ['--outputs-file', options.outputsFile, '--outputs-file-include-sensitive-outputs'] : [];
    return this.cdktf('deploy', stackName, outputs, options);
  }

  async destroy(stackName: string, options: ExecuteOptions = {}) {
    return this.cdktf('destroy', stackName, [], options);
  }

  private async cdktf(verb: 'deploy' | 'destroy', stackName: string, extra: string[], options: ExecuteOptions) {
    if ('off' in this.terraform.home) throw new Error(this.terraform.home.off);
    const home = this.terraform.home;
    if (home.kind === 'kubernetes' && !this.locks) throw new Error(`this process keeps the state of ${stackName} in the cluster but was given no way to free a lock a killed run left there`);
    const applyingHere = (applying.get(stackName) ?? 0) > 0;
    applying.set(stackName, (applying.get(stackName) ?? 0) + 1);
    try {
      if (home.kind === 'kubernetes' && this.locks) await this.freeLeftBehind(this.locks, home.namespace, stackName, applyingHere, options.logFile);
      return await this.cdktfIn(home, verb, stackName, extra, options);
    } finally {
      const left = (applying.get(stackName) ?? 1) - 1;
      if (left > 0) applying.set(stackName, left);
      else applying.delete(stackName);
    }
  }

  private async freeLeftBehind(locks: StateLocks, namespace: string, stackName: string, applyingHere: boolean, logFile: string | undefined): Promise<void> {
    const freed = await locks.freeLeftBehind(namespace, stackName, applyingHere);
    if (!freed) return;
    const line = `[terraform] the state of ${stackName} was still locked (${freed.id}) by ${freed.who}, whose run is gone; Koala freed it`;
    console.log(line);
    await fs.mkdir(this.terraform.logDir, { recursive: true });
    if (logFile) await fs.appendFile(logFile, `${line}\n`).catch(ignore('the log only shows progress, and the apply goes on without it'));
  }

  private async cdktfIn(home: TerraformStateHome, verb: 'deploy' | 'destroy', stackName: string, extra: string[], options: ExecuteOptions) {
    await adoptStateFromBefore(stackName, this.terraform);
    await dropSharedOutput(this.terraform.stateDir);
    const run = await fs.mkdtemp(path.join(this.terraform.runsDir ?? os.tmpdir(), 'koala-cdktf-'));
    try {
      const output = path.join(run, 'cdktf.out');
      const env = { ...options.env, ...cdktfStateEnv(home), ...(await this.providerConfig(run)), ...(this.terraform.chartSources ? { CHART_SOURCES: this.terraform.chartSources } : {}) };
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
    await terraformQuietly(this.processes, ['init', '-input=false', '-no-color'], stackDir, env);
    const move = stateMove(stackName, local, await terraformQuietly(this.processes, ['state', 'pull'], stackDir, env));
    if (move.step === 'refuse') throw new Error(move.reason);
    if (move.step === 'push') {
      await terraformQuietly(this.processes, ['state', 'push', '-force', kept], stackDir, env);
      const landed = stateMove(stackName, local, await terraformQuietly(this.processes, ['state', 'pull'], stackDir, env));
      if (landed.step !== 'forget') throw new Error(`the state of ${stackName} was pushed into the cluster but is not there; it stays in the data folder`);
    }
    for (const file of stateFilesOf(stackName)) await fs.rm(path.join(this.terraform.stateDir, file), { force: true });
  }

  async buildImage(tag: string, dockerfile: string, context: string, options: ExecuteOptions = {}) {
    const dockerfilePath = path.join(context, 'Dockerfile');
    await fs.writeFile(dockerfilePath, dockerfile);
    return this.runCommand('docker', ['build', '-t', tag, '.'], tag, { ...options, env: { ...options.env, ...passedOn(DOCKER_CLIENT), CD_DIR: context } });
  }

  async runCommand(cmd: string, args: string[], logId: string, options: ExecuteOptions = {}): Promise<{ stdout: string; logFile: string }> {
    const env = commandEnv(options.env);
    const logFile = options.logFile || this.getLogPath(logId);
    const cwd = options.env?.CD_DIR || this.terraform.cdktfDir;
    await fs.mkdir(this.terraform.logDir, { recursive: true });

    console.log(`[InfrastructureService] Spawning cmd=${cmd} args=${JSON.stringify(args)}`);

    if (options.signal?.aborted) throw stoppedBy(options.signal);
    const broadcast = (data: string) => {
      if (options.io && options.resourceId) options.io.to(options.resourceId).emit('log', data);
    };
    let logged = Promise.resolve();
    const log = (text: string): void => {
      logged = logged.then(() => fs.appendFile(logFile, text)).catch(console.error);
    };
    const said = (chunk: string): void => {
      broadcast(chunk);
      log(chunk);
    };
    const running = this.processes.start({ command: cmd, args, cwd, env }, { group: Boolean(options.signal), heard: { stdout: said, stderr: said } });
    const interrupt = () => {
      const stopping = `\n--- STOPPED: ${reasonOf(options.signal?.reason)} ---\n`;
      broadcast(stopping);
      log(stopping);
      running.stop('SIGINT');
    };
    options.signal?.addEventListener('abort', interrupt, { once: true });
    try {
      const ended = await running.ended.catch((err: Error) => {
        broadcast(`\n--- SPAWN ERROR: ${err.message} ---\n`);
        throw err;
      });
      if (options.signal?.aborted) throw stoppedBy(options.signal);
      if (ended.code === 0) return { stdout: ended.stdout, logFile };
      const failed = `\n--- EXECUTION FAILED (Exit Code ${ended.signal ?? ended.code}) ---\n`;
      broadcast(failed);
      log(failed);
      throw new CommandFailedError(cmd, ended.signal !== undefined ? null : ended.code, ended.stdout, ended.stderr, logFile);
    } finally {
      options.signal?.removeEventListener('abort', interrupt);
      await logged;
    }
  }
}
