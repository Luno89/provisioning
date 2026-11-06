import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { capabilitiesOf, type EnvironmentDriver, type EnvironmentSpec, type ExecRequest, type ExecResult } from '../src/environment.js';

const spec: EnvironmentSpec = { kind: 'sandbox', lifecycle: 'invocation' };

export function shellDriver(folder: string): EnvironmentDriver & { commands: string[] } {
  const commands: string[] = [];
  const refused = (what: string) => async (): Promise<never> => {
    throw new Error(`this shell driver only runs commands; it was asked to ${what}`);
  };
  return {
    commands,
    handle: () => ({ id: 'shell', spec, capabilities: capabilitiesOf(spec), approval: 'none' }),
    async exec(request: ExecRequest): Promise<ExecResult> {
      commands.push(request.command);
      const child = spawn('sh', ['-c', request.command], { cwd: request.cwd ?? folder, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (part: Buffer) => stdout.push(part));
      child.stderr.on('data', (part: Buffer) => stderr.push(part));
      const [code] = await once(child, 'close') as [number | null];
      return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? -1 };
    },
    readFile: refused('read a file'),
    writeFile: refused('write a file'),
    listDir: refused('list a folder'),
    deleteFile: refused('delete a file'),
  };
}
