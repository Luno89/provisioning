import { access, constants, mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadChecked } from '@koala/provision';
import { onMachine } from '../machine-cluster.js';

export interface Scratch {
  dir: string;
  remove(): Promise<void>;
}

export interface JoinHost {
  platform: NodeJS.Platform;
  arch: string;
  uid: number;
  user: string;
  group: string;
  home: string;
  hostname: string;
  os: string;
  env: Readonly<Record<string, string | undefined>>;
  at(file: string): string;
  read(file: string): Promise<string | undefined>;
  executable(file: string): Promise<boolean>;
  readOwn(file: string): Promise<string | undefined>;
  ownExecutable(file: string): Promise<boolean>;
  which(name: string): Promise<string | undefined>;
  modified(file: string): Promise<number | undefined>;
  writeOwn(file: string, content: string, mode: number): Promise<void>;
  makeFolder(folder: string): Promise<string>;
  scratch(): Promise<Scratch>;
  download(what: string, url: string, to: string, sha256: string): Promise<void>;
  fetch: typeof fetch;
}

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR';

export interface LocalHostOptions {
  env: Readonly<Record<string, string | undefined>>;
  machineRoot: string;
  user: { uid: number; name: string; group: string; home: string };
  hostname: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
}

const readText = (at: string, file: string): Promise<string | undefined> => readFile(at, 'utf8').then((text) => text, (err: unknown) => {
  if (missing(err)) return undefined;
  throw new Error(`${file} could not be read: ${(err as Error).message}`);
});

export function localJoinHost(options: LocalHostOptions): JoinHost {
  const at = onMachine(options.machineRoot);
  const executable = (file: string): Promise<boolean> => access(file, constants.X_OK).then(() => true, (err: unknown) => {
    if (missing(err) || (err as NodeJS.ErrnoException).code === 'EACCES') return false;
    throw err;
  });
  return {
    platform: options.platform ?? process.platform,
    arch: options.arch ?? os.arch(),
    uid: options.user.uid,
    user: options.user.name,
    group: options.user.group,
    home: options.user.home,
    hostname: options.hostname,
    os: `${os.type()} ${os.machine()}`,
    env: options.env,
    at,
    read: (file) => readText(at(file), file),
    executable: (file) => executable(at(file)),
    readOwn: (file) => readText(file, file),
    ownExecutable: executable,
    which: async (name) => {
      for (const dir of (options.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        if (await executable(path.join(dir, name))) return path.join(dir, name);
      }
      return undefined;
    },
    modified: (file) => stat(file).then((found) => found.mtimeMs, (err: unknown) => {
      if (missing(err)) return undefined;
      throw err;
    }),
    writeOwn: async (file, content, mode) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, { mode });
      await chmod(file, mode);
    },
    makeFolder: async (folder) => {
      await mkdir(folder, { recursive: true });
      return folder;
    },
    scratch: async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'koala-join-'));
      return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
    },
    download: (what, url, to, sha256) => downloadChecked({ what, url, to, sha256, fetcher: options.fetch ?? fetch }),
    fetch: options.fetch ?? fetch,
  };
}
