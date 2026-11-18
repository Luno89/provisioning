import type { Reporter } from './steps.js';

export interface Terminal {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export const ROLLING_LINES = 8;
const UNKNOWN_COLUMNS = 100;
const MARGIN = 6;
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;

const plain = (line: string): string => line.replace(ESCAPES, '');

export function terminalReporter(terminal: Terminal): Reporter {
  const tty = terminal.isTTY === true;
  let numbered = 0;
  let rolling: string[] = [];
  let onScreen = 0;
  const write = (text: string): void => { terminal.write(text); };
  const erase = (): void => {
    if (onScreen > 0) write(`\u001b[${onScreen}A\u001b[J`);
    onScreen = 0;
  };
  const clear = (): void => {
    erase();
    rolling = [];
  };
  const ended = (said: string): void => {
    clear();
    write(`  ${said}\n`);
  };
  return {
    started(step) {
      numbered += 1;
      clear();
      const header = `[${numbered}] ${step.title}`;
      write(tty ? `\n\u001b[1m${header}\u001b[0m\n` : `\n${header}\n`);
    },
    alreadyDone: () => { ended('already done'); },
    line(_step, text) {
      const line = plain(text);
      if (line.trim() === '') return;
      if (!tty) {
        write(`    ${line}\n`);
        return;
      }
      rolling = [...rolling, line].slice(-ROLLING_LINES);
      const width = (terminal.columns ?? UNKNOWN_COLUMNS) - MARGIN;
      erase();
      write(rolling.map((shown) => `    \u001b[2m${shown.slice(0, width)}\u001b[0m\n`).join(''));
      onScreen = rolling.length;
    },
    done: () => { ended('done'); },
    failed(_step, failure) {
      clear();
      if (!tty) {
        write(`  failed: ${failure.why}\n`);
        return;
      }
      write(failure.tail.map((line) => `    ${plain(line)}\n`).join(''));
      write(`  \u001b[31mfailed: ${failure.why}\u001b[0m\n`);
    },
  };
}
