import { ignore } from '../src/failures.js';
import { ProcessNotStarted, SIGNALLED, type Followed, type Heard, type Io, type ProcessResult, type ProcessRun, type Processes, type Streams } from '../src/processes.js';

export interface Answer {
  code?: number;
  stdout?: string | Buffer | ((input: string) => string);
  stderr?: string;
  signal?: string;
  runsUntilStopped?: boolean;
}

export type Script = (run: ProcessRun) => Answer | undefined;

export interface Recorded {
  run: ProcessRun;
  io: Omit<Io, 'input' | 'output' | 'heard'>;
  stoppedWith?: string;
}

export interface RecordingProcesses extends Processes, Streams {
  readonly ran: ProcessRun[];
  readonly recorded: Recorded[];
}

const streamed = (input: Io['input']): input is NodeJS.ReadableStream =>
  input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input);

const drained = (input: NodeJS.ReadableStream): Promise<string> =>
  new Promise((done, failed) => {
    const chunks: Buffer[] = [];
    input.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    input.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    input.on('error', failed);
  });

const FIRST_PID = 100_000;

const asText = (said: string | Buffer | undefined): string => (said === undefined ? '' : said.toString());

export function recordingProcesses(script: Script): RecordingProcesses {
  const ran: ProcessRun[] = [];
  const recorded: Recorded[] = [];
  let pids = FIRST_PID;

  const started = (run: ProcessRun, io: Io = {}): Followed => {
    const entry: Recorded = { run, io: { ...(io.group !== undefined ? { group: io.group } : {}) } };
    recorded.push(entry);
    let stopped: (signal: string) => void = () => undefined;
    const stop = new Promise<string>((done) => { stopped = done; });
    const ended = (async (): Promise<ProcessResult> => {
      const given = io.input ?? run.input;
      const asked: ProcessRun = given === undefined || streamed(given) ? { ...run } : { ...run, input: given };
      ran.push(asked);
      const read = streamed(given) ? drained(given).then((text) => { asked.input = text; return text; }) : Promise.resolve(asText(asked.input));
      const answer = script(asked);
      if (!answer) throw new ProcessNotStarted(run, Object.assign(new Error(`spawn ${run.command} ENOENT`), { code: 'ENOENT' }));
      const stdout = typeof answer.stdout === 'function' ? answer.stdout(await read) : answer.stdout;
      if (io.output && stdout !== undefined) await new Promise<void>((done, failed) => {
        io.output!.on('error', failed);
        io.output!.end(Buffer.from(stdout), () => { done(); });
      });
      else if (stdout !== undefined) io.heard?.stdout?.(asText(stdout));
      if (answer.stderr !== undefined) io.heard?.stderr?.(answer.stderr);
      const said = { stdout: io.output ? '' : asText(stdout), stderr: answer.stderr ?? '' };
      if (answer.runsUntilStopped) {
        const signal = await stop;
        entry.stoppedWith = signal;
        return { code: SIGNALLED, signal, ...said };
      }
      if (answer.signal !== undefined) return { code: SIGNALLED, signal: answer.signal, ...said };
      return { code: answer.code ?? 0, ...said };
    })();
    pids += 1;
    const exited = ended.then(({ code, signal }) => (signal !== undefined ? { code, signal } : { code }));
    exited.catch(ignore('a program that could not start rejects ended as well, which is where its caller hears it'));
    return { pid: pids, stop: (signal = 'SIGKILL') => { stopped(signal); }, exited, ended };
  };

  return {
    ran,
    recorded,
    run: (run: ProcessRun, heard?: Heard) => started(run, heard ? { heard } : {}).ended,
    pipe: (run: ProcessRun, input: NodeJS.ReadableStream) => started(run, { input }).ended,
    follow: (run: ProcessRun, onOutput: (chunk: string) => void) => started(run, { heard: { stdout: onOutput } }),
    start: (run: ProcessRun, io?: Io) => started(run, io),
  };
}
