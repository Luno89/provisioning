import { randomUUID } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';

export async function writePrivate(path: string, content: string): Promise<void> {
  const staged = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    await chmod(staged, 0o600);
    await rename(staged, path);
  } catch (err) {
    await rm(staged, { force: true });
    throw err;
  }
}
