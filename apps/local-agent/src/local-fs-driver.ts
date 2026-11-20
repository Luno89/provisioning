import fs from 'fs/promises';
import path from 'path';
import { passedOn, PERSON_SESSION } from '@koala/engine-core/child-env';
import { execForModel } from '@koala/engine-core/model-exec';
import { nodeStreams } from '@koala/engine-core/node-processes';
import type { Streams } from '@koala/engine-core/processes';
import {
  capabilitiesOf,
  scopedPath,
  type DirEntry,
  type EnvironmentDriver,
  type EnvironmentHandle,
  type EnvironmentScope,
  type EnvironmentSpec,
  type ExecRequest,
  type ExecResult,
} from '@koala/engine-core';

export interface LocalFsDriverOptions {
  rootDir: string;
  deviceId: string;
  scope?: EnvironmentScope | undefined;
  languages?: string[] | undefined;
  shell?: string | undefined;
  streams?: Streams | undefined;
}

export function createLocalFsDriver(options: LocalFsDriverOptions): EnvironmentDriver {
  const spec: EnvironmentSpec = {
    kind: 'machine',
    lifecycle: 'persistent',
    ...(options.languages ? { languages: [...options.languages] } : {}),
    egress: true,
  };

  const handle: EnvironmentHandle = {
    id: `machine:${options.deviceId}`,
    spec,
    capabilities: capabilitiesOf(spec),
    ...(options.scope ? { scope: options.scope } : {}),
    approval: 'none',
  };

  const absolute = (requested: string): string =>
    path.resolve(options.rootDir, scopedPath(options.scope, requested));

  const workingDir = (requested?: string): string =>
    (requested ? absolute(requested) : path.resolve(options.rootDir, scopedPath(options.scope, '.')));

  return {
    handle: () => handle,

    async exec({ cwd, ...request }: ExecRequest): Promise<ExecResult> {
      return execForModel({
        streams: options.streams ?? nodeStreams,
        shell: [options.shell ?? '/bin/bash', '-lc'],
        cwd: workingDir(cwd),
        env: passedOn(PERSON_SESSION),
      }, request);
    },

    async readFile(requested: string): Promise<string> {
      return fs.readFile(absolute(requested), 'utf8');
    },

    async writeFile(requested: string, content: string): Promise<void> {
      const target = absolute(requested);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    },

    async listDir(requested: string): Promise<DirEntry[]> {
      const entries = await fs.readdir(absolute(requested), { withFileTypes: true });
      return entries
        .filter((entry) => entry.name !== '.git')
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' as const : 'file' as const }));
    },

    async deleteFile(requested: string): Promise<void> {
      await fs.rm(absolute(requested), { recursive: true, force: true });
    },
  };
}
