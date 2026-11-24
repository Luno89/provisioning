import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { Ran, RanRange } from './collect.js';

const NEWLINE = 10;

export function writeRan(path: string, ran: Ran): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, `${JSON.stringify({ testFile: ran.testFile })}\n`);
    for (const [file, ranges] of Object.entries(ran.files)) writeSync(fd, `${JSON.stringify([file, ranges])}\n`);
  } finally {
    closeSync(fd);
  }
}

function* linesOf(bytes: Buffer): Generator<string> {
  for (let start = 0; start < bytes.length;) {
    const found = bytes.indexOf(NEWLINE, start);
    const end = found < 0 ? bytes.length : found;
    if (end > start) yield bytes.toString('utf8', start, end);
    start = end + 1;
  }
}

export function readRan(path: string): Ran {
  const lines = linesOf(readFileSync(path));
  const head = lines.next();
  if (head.done) throw new Error(`${path} holds no record of a test file's run`);
  const { testFile } = JSON.parse(head.value) as { testFile: string };
  const files: Record<string, RanRange[]> = {};
  for (const line of lines) {
    const [file, ranges] = JSON.parse(line) as [string, RanRange[]];
    files[file] = ranges;
  }
  return { testFile, files };
}
