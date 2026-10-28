import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function saveDeviceToken(file: string, token: string): Promise<void> {
  const saved = await readFile(file, 'utf8').then(
    (raw) => JSON.parse(raw) as Record<string, unknown>,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return {};
      throw err;
    },
  );
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const draft = `${file}.${process.pid}.next`;
  await writeFile(draft, `${JSON.stringify({ ...saved, token }, null, 2)}\n`, { mode: 0o600 });
  await rename(draft, file);
}

export const tokenAnswer = (taken: boolean): { taken: boolean } => ({ taken });
