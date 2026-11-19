import { capabilitiesOf, type EnvironmentDriver, type EnvironmentSpec, type ExecRequest, type ExecResult } from '../src/environment.js';
import { execForModel } from '../src/model-exec.js';
import { nodeStreams } from '../src/node-processes.js';
import type { Streams } from '../src/processes.js';

const spec: EnvironmentSpec = { kind: 'sandbox', lifecycle: 'invocation' };

export function shellDriver(folder: string, streams: Streams = nodeStreams): EnvironmentDriver & { commands: string[] } {
  const commands: string[] = [];
  const refused = (what: string) => async (): Promise<never> => {
    throw new Error(`this shell driver only runs commands; it was asked to ${what}`);
  };
  return {
    commands,
    handle: () => ({ id: 'shell', spec, capabilities: capabilitiesOf(spec), approval: 'none' }),
    async exec(request: ExecRequest): Promise<ExecResult> {
      commands.push(request.command);
      return execForModel({ streams, shell: ['sh', '-c'], cwd: folder }, request);
    },
    readFile: refused('read a file'),
    writeFile: refused('write a file'),
    listDir: refused('list a folder'),
    deleteFile: refused('delete a file'),
  };
}
