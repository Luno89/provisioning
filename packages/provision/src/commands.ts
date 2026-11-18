import { lineSplitter } from './lines.js';
import { TAIL_LINES, type Progress } from './steps.js';
import { tail } from './tail.js';

export interface Command {
  command: string;
  args?: readonly string[];
  sudo?: boolean;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  cwd?: string;
  accept?: readonly number[];
}

export interface Ran {
  code: number;
  stdout: string;
}

export interface CommandRunner {
  run(command: Command, progress: Progress): Promise<Ran>;
}

export type Ending = { code: number } | { signal: string } | { notStarted: string };

export class CommandFailed extends Error {
  constructor(readonly argv: readonly string[], readonly ending: Ending, readonly tail: readonly string[]) {
    super(`${shown(argv)} ${endingSaid(ending)}`);
    this.name = 'CommandFailed';
  }

  get code(): number | undefined {
    return 'code' in this.ending ? this.ending.code : undefined;
  }
}

function endingSaid(ending: Ending): string {
  if ('code' in ending) return `exited with ${ending.code}`;
  if ('signal' in ending) return `was stopped by ${ending.signal}`;
  return `could not start: ${ending.notStarted}`;
}

const PLAIN = /^[\w@%+=:,./-]+$/;

const quoted = (arg: string): string => (PLAIN.test(arg) ? arg : `'${arg.replaceAll(`'`, `'\\''`)}'`);

export function shown(argv: readonly string[]): string {
  return argv.map(quoted).join(' ');
}

export function argvOf(command: Command): string[] {
  const own = [command.command, ...(command.args ?? [])];
  if (!command.sudo) return own;
  const env = Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${value}`);
  return ['sudo', '--', ...(env.length > 0 ? ['env', ...env] : []), ...own];
}

const accepted = (command: Command, code: number): boolean => (command.accept ?? [0]).includes(code);

export interface CommandOutput {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  ended(ending: Ending): Ran;
}

export function commandOutput(command: Command, progress: Progress): CommandOutput {
  const printed = tail(TAIL_LINES);
  const said = (line: string): void => {
    printed.add(line);
    progress.line(line);
  };
  const out = lineSplitter(said);
  const err = lineSplitter(said);
  let stdout = '';
  return {
    stdout(chunk) {
      stdout += chunk;
      out.push(chunk);
    },
    stderr: (chunk) => { err.push(chunk); },
    ended(ending) {
      out.end();
      err.end();
      if ('code' in ending && accepted(command, ending.code)) return { code: ending.code, stdout };
      const { env: _env, ...named } = command;
      throw new CommandFailed(argvOf(named), ending, printed.lines());
    },
  };
}
