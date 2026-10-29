export interface InvisibleRemoved {
  text: string;
  removed: number;
}

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const LETTER = /\p{L}/u;
const ALWAYS_INVISIBLE = /^[\u200B\u2060\u202A-\u202E\u2066-\u2069]$/;

const isTag = (codePoint: number): boolean => codePoint >= 0xE0000 && codePoint <= 0xE007F;

function joinerKept(previous: string | undefined, next: string | undefined): boolean {
  return Boolean(previous && next && (PICTOGRAPH.test(previous) || previous === '\uFE0F') && PICTOGRAPH.test(next));
}

function nonJoinerKept(previous: string | undefined, next: string | undefined): boolean {
  return Boolean(previous && next && LETTER.test(previous) && LETTER.test(next));
}

export function withoutInvisible(text: string): InvisibleRemoved {
  const chars = Array.from(text);
  let removed = 0;
  const kept: string[] = [];
  chars.forEach((char, index) => {
    const codePoint = char.codePointAt(0)!;
    const previous = kept.at(-1);
    const next = chars[index + 1];
    const drop = isTag(codePoint)
      || ALWAYS_INVISIBLE.test(char)
      || (char === '\uFEFF' && index > 0)
      || (char === '\u200D' && !joinerKept(previous, next))
      || (char === '\u200C' && !nonJoinerKept(previous, next));
    if (drop) removed += 1;
    else kept.push(char);
  });
  return { text: removed ? kept.join('') : text, removed };
}

const DROPPED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'head']);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

const attribute = (attrs: string, name: string): string | undefined => {
  const found = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+))?`, 'i').exec(attrs);
  if (!found) return undefined;
  return (found[1] ?? '').replace(/^["']|["']$/g, '');
};

export function hiddenByAttributes(tag: string, attrs: string): boolean {
  if (attribute(attrs, 'hidden') !== undefined) return true;
  if ((attribute(attrs, 'aria-hidden') ?? '').toLowerCase() === 'true') return true;
  if (tag === 'input' && (attribute(attrs, 'type') ?? '').toLowerCase() === 'hidden') return true;
  const style = (attribute(attrs, 'style') ?? '').toLowerCase().replace(/\s+/g, '');
  return /display:none|visibility:hidden|font-size:0(?:px|em|rem|%)?(?:;|$)|opacity:0(?:;|$)/.test(style);
}

export interface HiddenHtmlRemoved {
  html: string;
  removed: number;
}

export function withoutHiddenHtml(html: string): HiddenHtmlRemoved {
  let out = '';
  let removed = 0;
  let cursor = 0;
  let skipping: { tag: string; depth: number } | undefined;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(html); match; match = TAG.exec(html)) {
    const [whole, closing, rawTag, attrs = ''] = match;
    if (!skipping) out += html.slice(cursor, match.index);
    cursor = match.index + whole.length;
    if (whole.startsWith('<!--')) {
      if (!skipping) removed += 1;
      continue;
    }
    const tag = rawTag!.toLowerCase();
    if (skipping) {
      if (tag === skipping.tag) skipping.depth += closing ? -1 : 1;
      if (skipping.depth === 0) skipping = undefined;
      continue;
    }
    if (closing) {
      out += whole;
      continue;
    }
    const selfClosing = VOID_ELEMENTS.has(tag) || attrs.trimEnd().endsWith('/');
    if (DROPPED_ELEMENTS.has(tag) || tag === 'meta' || hiddenByAttributes(tag, attrs)) {
      removed += 1;
      if (!selfClosing) skipping = { tag, depth: 1 };
      continue;
    }
    out += whole;
  }
  if (!skipping) out += html.slice(cursor);
  return { html: removed ? out : html, removed };
}

export const looksLikeHtml = (text: string): boolean => /<(?:html|body|div|p|span|head|!--)[\s>]/i.test(text) && (text.match(/<\/?[a-zA-Z][^>]*>/g)?.length ?? 0) >= 3;

export function withoutHidden(text: string): InvisibleRemoved {
  const html = looksLikeHtml(text) ? withoutHiddenHtml(text) : { html: text, removed: 0 };
  const invisible = withoutInvisible(html.html);
  return { text: invisible.text, removed: html.removed + invisible.removed };
}
