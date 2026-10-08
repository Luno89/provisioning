const OPENS: Record<string, string> = { '{': '}', '[': ']' };
const CLOSES: Record<string, string> = { '}': '{', ']': '[' };
const NAMES: Record<string, string> = { '{': 'an object', '[': 'a list', '}': 'an object', ']': 'a list' };

const around = (text: string, at: number, width = 60): string => {
  const start = Math.max(0, at - width);
  const end = Math.min(text.length, at + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, at)}⟪here⟫${text.slice(at, end)}${end < text.length ? '…' : ''}`;
};

const labelOf = (text: string, at: number): string => {
  const before = text.slice(Math.max(0, at - 40), at);
  const key = /"([^"]+)"\s*:\s*$/.exec(before)?.[1];
  return key ? ` (the one under "${key}")` : '';
};

export function explainJsonError(text: string, parserMessage: string): string {
  const stack: { bracket: string; at: number }[] = [];
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (inString) {
      if (char === '\\') at += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (OPENS[char]) stack.push({ bracket: char, at });
    else if (CLOSES[char]) {
      const open = stack.at(-1);
      if (!open) return `a ${char} at character ${at} closes ${NAMES[char]} that was never opened: ${around(text, at)}`;
      if (open.bracket !== CLOSES[char]) {
        return `a ${char} at character ${at} closes ${NAMES[char]}, but the innermost thing still open there is ${NAMES[open.bracket]}${labelOf(text, open.at)} — one bracket too many or too few just before it: ${around(text, at)}`;
      }
      stack.pop();
    }
  }
  if (inString) return `a string is never closed — a " is missing or unescaped: ${around(text, text.length)}`;
  if (stack.length > 0) {
    const open = stack.at(-1)!;
    return `${stack.length} bracket${stack.length === 1 ? '' : 's'} never closed — the last one opened is ${NAMES[open.bracket]}${labelOf(text, open.at)}: ${around(text, open.at)}`;
  }
  const at = Number(/position (\d+)/.exec(parserMessage)?.[1]);
  return Number.isFinite(at) ? `${parserMessage}: ${around(text, at)}` : parserMessage;
}
