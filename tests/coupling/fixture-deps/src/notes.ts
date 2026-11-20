import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function keep(folder: string, text: string): Promise<void> {
  await writeFile(join(folder, 'notes.txt'), text);
}

export async function recall(folder: string): Promise<string> {
  return readFile(join(folder, 'notes.txt'), 'utf8');
}
