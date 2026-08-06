/**
 * A small syntax-highlighted editor.
 *
 * ── HOW THE HIGHLIGHTING WORKS ──
 * A transparent textarea sits exactly on top of a coloured `<pre>` holding the same text. You type
 * into the textarea and read the `<pre>`. The two must agree on every metric that affects layout —
 * font, size, line height, padding, wrapping — or the caret drifts from the glyphs, so those live
 * in one shared class rather than being set twice.
 *
 * Tokens become React elements rather than an HTML string. A highlighter that builds markup has to
 * escape its input perfectly every time, and the input here includes prompts and shell commands
 * written by a model — exactly the text most likely to contain the character that breaks it.
 *
 * Deliberately small: three languages, a handful of token classes. This exists to make a 1,600
 * character prompt readable, not to be an IDE.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { Language } from './shared';

const TONE = {
  string: 'text-[var(--leaf-light)]',
  comment: 'text-slate-600 italic',
  number: 'text-amber-300',
  keyword: 'text-sky-300',
  operator: 'text-slate-500',
  flag: 'text-amber-400',
} as const;

/**
 * One regex per language, with every token type as a named alternative.
 *
 * Ordered so the greedy cases win: a `#` inside a string is not a comment, so strings match first.
 */
const PATTERNS: Record<Exclude<Language, 'text'>, RegExp> = {
  shell: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[^\n]*)|(\s--?[\w-]+)|(&&|\|\||[|;><])|(\b\d+\b)/g,
  js: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\b(?:const|let|var|function|return|if|else|for|while|require|import|export|new|throw|await|async|class)\b)|(\b\d+(?:\.\d+)?\b)/g,
  json: /("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?\b)/g,
};

/** Which capture group maps to which tone, per language. */
const GROUPS: Record<Exclude<Language, 'text'>, (keyof typeof TONE)[]> = {
  shell: ['string', 'comment', 'flag', 'operator', 'number'],
  js: ['string', 'comment', 'keyword', 'number'],
  json: ['string', 'keyword', 'number'],
};

function highlight(text: string, language: Language) {
  if (language === 'text') return text;

  const pattern = new RegExp(PATTERNS[language].source, 'g');
  const groups = GROUPS[language];
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    // A zero-width match would spin forever; nudging past it is cheaper than proving it cannot.
    if (match.index === pattern.lastIndex) { pattern.lastIndex++; continue; }
    if (match.index > last) out.push(text.slice(last, match.index));

    const which = groups.findIndex((_, i) => match![i + 1] !== undefined);
    out.push(
      <span key={key++} className={which >= 0 ? TONE[groups[which]!] : ''}>
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** Everything that affects glyph position, in one place so both layers cannot disagree. */
const METRICS = 'font-mono text-[12px] leading-[1.6] p-3 whitespace-pre-wrap break-words';

export function CodeEditor({
  value, onChange, language = 'text', autoFocus, className = '', label,
}: {
  value: string;
  onChange: (value: string) => void;
  language?: Language;
  autoFocus?: boolean;
  className?: string;
  /** Names the field. The visible heading is a sibling, so without this the textarea has none. */
  label?: string;
}) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const painted = useRef<HTMLPreElement | null>(null);

  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);

  return (
    <div className={`relative bg-[var(--bark-900)] border border-[var(--bark-600)] rounded overflow-hidden ${className}`}>
      <pre
        ref={painted}
        aria-hidden
        className={`${METRICS} absolute inset-0 m-0 overflow-auto text-slate-300 pointer-events-none`}
      >
        {highlight(value, language)}
        {/* A trailing newline collapses in a <pre>, which would shorten the painted layer by a
            line and drift the caret on the last row. */}
        {'\n'}
      </pre>
      <textarea
        ref={input}
        value={value}
        aria-label={label}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        // Scroll is driven by the textarea and mirrored, since only one of the two can be scrolled.
        onScroll={() => {
          if (painted.current && input.current) {
            painted.current.scrollTop = input.current.scrollTop;
            painted.current.scrollLeft = input.current.scrollLeft;
          }
        }}
        className={`${METRICS} relative w-full h-full bg-transparent text-transparent caret-slate-200 resize-none focus:outline-none`}
      />
    </div>
  );
}
