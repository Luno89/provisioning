import {
  capabilitiesOf,
  type DirEntry,
  type EnvironmentDriver,
  type EnvironmentHandle,
  type EnvironmentSpec,
  type ExecRequest,
  type ExecResult,
} from './environment.js';

export class NoEnvironmentError extends Error {
  constructor(action: string) {
    super(`This agent has no machine, so it cannot ${action}.`);
    this.name = 'NoEnvironmentError';
  }
}

export interface NoneDriverOptions {
  id?: string | undefined;
  egress?: boolean | undefined;
}

export function createNoneDriver(options: NoneDriverOptions = {}): EnvironmentDriver {
  const spec: EnvironmentSpec = {
    kind: 'none',
    lifecycle: 'invocation',
    ...(options.egress ? { egress: true } : {}),
  };

  const handle: EnvironmentHandle = {
    id: options.id ?? 'no-environment',
    spec,
    capabilities: capabilitiesOf(spec),
    approval: 'none',
  };

  return {
    handle: () => handle,
    async exec(_request: ExecRequest): Promise<ExecResult> {
      throw new NoEnvironmentError('run commands');
    },
    async readFile(_path: string): Promise<string> {
      throw new NoEnvironmentError('read files');
    },
    async writeFile(_path: string, _content: string): Promise<void> {
      throw new NoEnvironmentError('write files');
    },
    async listDir(_path: string): Promise<DirEntry[]> {
      throw new NoEnvironmentError('list directories');
    },
    async deleteFile(_path: string): Promise<void> {
      throw new NoEnvironmentError('delete files');
    },
  };
}
