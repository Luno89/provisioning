import { ignore } from '@koala/engine-core/failures';
import { closeSync, openSync } from 'node:fs';
import readline from 'node:readline/promises';
import tty from 'node:tty';

export const yesAnswer = (answer: string): boolean => /^(|y|yes)$/i.test(answer.trim());

export const yesOnlyAnswer = (answer: string): boolean => /^(y|yes)$/i.test(answer.trim());

type Heard = { answer: string } | 'no terminal' | 'not answered';

async function onTerminal(prompt: string): Promise<Heard> {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    return 'no terminal';
  }
  const input = new tty.ReadStream(fd);
  const output = new tty.WriteStream(fd);
  const lines = readline.createInterface({ input, output });
  try {
    return { answer: await lines.question(prompt) };
  } catch {
    return 'not answered';
  } finally {
    lines.close();
    input.destroy();
    output.destroy();
    try {
      closeSync(fd);
    } catch (failure) {
      ignore('destroying the streams has usually closed the terminal already')(failure);
    }
  }
}

export async function askOnTerminal(question: string): Promise<boolean | undefined> {
  const heard = await onTerminal(`  ${question} [Y/n] `);
  if (heard === 'no terminal') return undefined;
  return heard !== 'not answered' && yesAnswer(heard.answer);
}

export async function askNoByDefault(question: string): Promise<boolean> {
  const heard = await onTerminal(`  ${question} [y/N] `);
  return typeof heard === 'object' && yesOnlyAnswer(heard.answer);
}

export async function askFolder(question: string, offered: string): Promise<string> {
  const heard = await onTerminal(`  ${question} [${offered}] `);
  return typeof heard === 'object' && heard.answer.trim() ? heard.answer.trim() : offered;
}
