import { chmod, writeFile } from 'node:fs/promises';

export async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf-8', mode: 0o600 });
  await chmod(path, 0o600);
}
