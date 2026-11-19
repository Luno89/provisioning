import path from 'node:path';
import { allReporters, keptSudo, runSteps, StepFailed, terminalReporter, type CommandRunner, type Every, type Reporter, type Terminal, type WaitOptions } from '@koala/provision';
import type { AdapterChoice } from '../agent-setup.js';
import { followInstall, type FollowEnd } from './follow-install.js';
import { folderProblem } from '../machine-config.js';
import { joinArgsOf, JoinUsage, type JoinArgs } from './args.js';
import { joinedOf, type JoinContext } from './context.js';
import type { JoinHost } from './host.js';
import { joinPins, type JoinPins } from './pins.js';
import { JoinStopped, planJoin } from './plan.js';
import { JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { rootProgress, rootReporter, rootUrlOf } from '../root-progress.js';

export interface JoinAsking {
  yesNo(question: string): Promise<boolean>;
  text(question: string, offered: string): Promise<string>;
}

export interface JoinDeps {
  host: JoinHost;
  commands: CommandRunner;
  terminal: Terminal;
  ask: JoinAsking;
  agentDir: string;
  node: string;
  setUpAgents(choice: AdapterChoice, folder: string): Promise<void>;
  rootReporter?: (url: string, code: string) => Reporter;
  pins?: (args: JoinArgs) => JoinPins;
  every?: Every;
  onInterrupt?: (stop: () => void) => () => void;
  followWait?: WaitOptions;
}

const BOLD = (terminal: Terminal, text: string): string => (terminal.isTTY ? `\u001b[1m${text}\u001b[0m` : text);

async function folderOf(args: JoinArgs, deps: JoinDeps, say: (line: string) => void): Promise<string> {
  const offered = path.join(deps.host.home, 'koala');
  const given = args.folder ?? (args.yes ? offered : await deps.ask.text('Which folder may Koala work in?', offered));
  const expanded = given === '~' || given.startsWith('~/') ? path.join(deps.host.home, given.slice(1)) : given;
  const folder = path.resolve(expanded);
  const problem = folderProblem(folder, deps.host.home);
  if (problem) throw new JoinStopped(problem);
  await deps.host.makeFolder(folder);
  say(`Koala works in ${folder}, and nowhere else`);
  return folder;
}

const FOLLOWED_EXIT: Record<Exclude<FollowEnd, 'none'>, number> = { ready: 0, failed: 1, stopped: 1, interrupted: 130 };

async function followKoala(args: JoinArgs, token: string, deps: JoinDeps, say: (line: string) => void, section: (title: string) => void): Promise<FollowEnd> {
  const watching = new AbortController();
  const release = deps.onInterrupt?.(() => { watching.abort(new Error('the person stopped watching')); });
  try {
    const end = await followInstall({ rootUrl: args.url, token, fetch: deps.host.fetch, say, section, interrupted: watching.signal, wait: deps.followWait });
    if (end === 'interrupted') say('Putting Koala on this machine carries on; My Machines shows it');
    return end;
  } finally {
    release?.();
  }
}

export async function runJoin(argv: readonly string[], deps: JoinDeps): Promise<number> {
  const out = (text: string): void => { deps.terminal.write(text); };
  const say = (line: string): void => out(`  ${line}\n`);
  const section = (title: string): void => out(`\n${BOLD(deps.terminal, title)}\n`);
  let args: JoinArgs;
  try {
    args = joinArgsOf(argv);
  } catch (err) {
    if (!(err instanceof JoinUsage)) throw err;
    say(err.message);
    return 2;
  }
  if (deps.host.uid === 0) {
    say('run this as yourself, not root: the agents it finds are yours');
    return 1;
  }
  const commands = keptSudo(deps.commands, { lost: say, ...(deps.every ? { every: deps.every } : {}) });
  const ask = { yesNo: (question: string) => (args.yes ? Promise.resolve(true) : deps.ask.yesNo(question)) };
  try {
    section('Checking this machine');
    const folder = await folderOf(args, deps, say);
    const ctx: JoinContext = { args, host: deps.host, commands, pins: (deps.pins ?? ((given) => joinPins(given.k3sMirror)))(args), folder, agentDir: deps.agentDir, node: deps.node };
    const plan = await planJoin(ctx, ask, say);
    const reporter = allReporters(terminalReporter(deps.terminal), (deps.rootReporter ?? ((url, code) => rootReporter(rootProgress(rootUrlOf(url, JOIN_PROGRESS_PATH), code, deps.host.fetch))))(args.url, args.code));
    await runSteps(plan.steps, ctx, reporter);
    section('Coding agents on this machine');
    await deps.setUpAgents(args.adapters, folder).then(
      () => undefined,
      (err: Error) => { say(`Koala could not look for coding agents now (${err.message}); it looks again each time this machine connects.`); },
    );
    if (plan.service) {
      await runSteps([plan.service], ctx, reporter);
      const followed = await followKoala(args, joinedOf(ctx).token, deps, say, section);
      if (followed !== 'none') return FOLLOWED_EXIT[followed];
    } else {
      section('Start it with');
      say(`${deps.node} ${path.join(deps.agentDir, 'agent.mjs')}`);
    }
    section('Done');
    say('This machine shows on My Machines in a moment, with the coding agents it found.');
    return 0;
  } catch (err) {
    if (err instanceof StepFailed) return 1;
    say(err instanceof JoinStopped ? err.message : `stopped: ${(err as Error).message}`);
    return 1;
  } finally {
    commands.end();
  }
}
