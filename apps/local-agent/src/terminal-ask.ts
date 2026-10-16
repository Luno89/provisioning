import { closeSync, openSync } from 'node:fs';
import readline from 'node:readline/promises';
import tty from 'node:tty';

export const yesAnswer = (answer: string): boolean => /^(|y|yes)$/i.test(answer.trim());

export async function askOnTerminal(question: string): Promise<boolean | undefined> {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    return undefined;
  }
  const input = new tty.ReadStream(fd);
  const output = new tty.WriteStream(fd);
  const lines = readline.createInterface({ input, output });
  try {
    return yesAnswer(await lines.question(`  ${question} [Y/n] `));
  } catch {
    return false;
  } finally {
    lines.close();
    input.destroy();
    output.destroy();
    try { closeSync(fd); } catch {}
  }
}
