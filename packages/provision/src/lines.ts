export interface LineSplitter {
  push(chunk: string): void;
  end(): void;
}

const LINE_END = /\r\n|\n|\r/;

export function lineSplitter(onLine: (line: string) => void): LineSplitter {
  let pending = '';
  return {
    push(chunk) {
      const pieces = (pending + chunk).split(LINE_END);
      pending = pieces.pop() ?? '';
      for (const piece of pieces) onLine(piece);
    },
    end() {
      if (pending !== '') onLine(pending);
      pending = '';
    },
  };
}
