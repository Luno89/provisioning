import { describe, expect, it } from 'vitest';
import { lineSplitter } from './lines.js';

const split = (...chunks: string[]): string[] => {
  const lines: string[] = [];
  const splitter = lineSplitter((line) => lines.push(line));
  for (const chunk of chunks) splitter.push(chunk);
  splitter.end();
  return lines;
};

describe('lineSplitter', () => {
  it('gives each whole line once, joining lines that arrive in pieces', () => {
    expect(split('one\ntw', 'o\nthr', 'ee\n')).toEqual(['one', 'two', 'three']);
  });

  it('gives the last line when the output ends without a newline', () => {
    expect(split('done')).toEqual(['done']);
  });

  it('treats a carriage return as the end of a line, as a progress bar redraws it', () => {
    expect(split('10%\r20%\rdone\r\n')).toEqual(['10%', '20%', 'done']);
  });

  it('gives nothing for output that ends cleanly', () => {
    expect(split('one\n', '')).toEqual(['one']);
    expect(split()).toEqual([]);
  });
});
