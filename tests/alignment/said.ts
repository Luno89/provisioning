export type SaidHow = 'typed' | 'while-working' | 'suggestion' | 'answer' | 'refusal';

export interface Said {
  at: string;
  session: string;
  agent?: string;
  how: SaidHow;
  text: string;
  question?: string;
}

const MAY_HOLD_WORDS = ['"kind":"human"', '"answers":', 'the user said:'];
const CLARIFY_TEMPLATE = 'The user wants to clarify these questions.';
const SAID_MARKER = 'To tell you how to proceed, the user said:';
const SENT_WHILE_WORKING = 'The user sent a new message while you were working:';
const RELAY_NOTE = 'This is how Claude Code surfaces messages the user sends mid-turn';
const HARNESS_BLOCKS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g;

export const mayHoldWords = (line: string): boolean => MAY_HOLD_WORDS.some((marker) => line.includes(marker));

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const ownWords = (text: string): string => text.replace(HARNESS_BLOCKS, '').trim();

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n');
};

const fromHuman = (record: Json): boolean => isRecord(record.origin) && record.origin.kind === 'human';

const howTyped = (source: unknown): SaidHow => (source === 'suggestion_accepted' ? 'suggestion' : source === 'queued' ? 'while-working' : 'typed');

const answersIn = (result: unknown): Array<{ question: string; text: string }> => {
  if (!isRecord(result) || !isRecord(result.answers)) return [];
  const notes = isRecord(result.annotations) ? result.annotations : {};
  return Object.entries(result.answers).flatMap(([question, answer]) => {
    if (typeof answer !== 'string') return [];
    const note = notes[question];
    const noted = isRecord(note) && typeof note.notes === 'string' && note.notes.trim() ? `${answer} (note: ${note.notes.trim()})` : answer;
    return [{ question, text: noted }];
  });
};

const refusalsIn = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== 'tool_result') return [];
    const text = textOf(part.content) || (typeof part.content === 'string' ? part.content : '');
    const at = text.indexOf(SAID_MARKER);
    if (at < 0) return [];
    const said = text.slice(at + SAID_MARKER.length).trim();
    return said && !said.startsWith(CLARIFY_TEMPLATE) ? [said] : [];
  });
};

export function saidOnLine(line: string, session: string, agent?: string): Said[] {
  if (!mayHoldWords(line)) return [];
  const record = JSON.parse(line) as unknown;
  if (!isRecord(record)) return [];
  const at = typeof record.timestamp === 'string' ? record.timestamp : '';
  const base = { at, session, ...(agent ? { agent } : {}) };
  if (record.type === 'attachment' && isRecord(record.attachment)) {
    const attachment = record.attachment;
    if (attachment.type !== 'queued_command' || !isRecord(attachment.origin) || attachment.origin.kind !== 'human' || typeof attachment.prompt !== 'string') return [];
    const text = ownWords(attachment.prompt);
    return text ? [{ ...base, how: 'while-working', text }] : [];
  }
  if (record.type !== 'user' || record.isCompactSummary === true || !isRecord(record.message)) return [];
  const content = record.message.content;
  const found: Said[] = [];
  if (fromHuman(record)) {
    const words = ownWords(textOf(content));
    const relayed = words.startsWith(SENT_WHILE_WORKING);
    const relayedText = words.slice(SENT_WHILE_WORKING.length);
    const noteAt = relayedText.indexOf(RELAY_NOTE);
    const text = relayed ? (noteAt >= 0 ? relayedText.slice(0, noteAt) : relayedText).trim() : words;
    if (text && (relayed || record.isMeta !== true)) found.push({ ...base, how: relayed ? 'while-working' : howTyped(record.promptSource), text });
  } else if (record.isMeta === true) return [];
  for (const answer of answersIn(record.toolUseResult)) found.push({ ...base, how: 'answer', text: answer.text, question: answer.question });
  for (const text of refusalsIn(content)) found.push({ ...base, how: 'refusal', text });
  return found;
}

const SAME_MESSAGE_MS = 60_000;

export function withoutRepeats(said: readonly Said[]): Said[] {
  const kept: Said[] = [];
  for (const entry of said) {
    const repeat = kept.some((other) => other.text === entry.text && other.session === entry.session && Math.abs(Date.parse(other.at) - Date.parse(entry.at)) < SAME_MESSAGE_MS);
    if (!repeat) kept.push(entry);
  }
  return kept;
}

export function matching(said: readonly Said[], words: readonly string[], since?: string): Said[] {
  const wanted = words.map((word) => word.toLowerCase());
  return said.filter((entry) => {
    if (since && entry.at < since) return false;
    const haystack = `${entry.text}\n${entry.question ?? ''}`.toLowerCase();
    return wanted.every((word) => haystack.includes(word));
  });
}

export function excerpt(text: string, words: readonly string[], room: number): string {
  const flat = text.replace(/\s+/g, ' ');
  if (flat.length <= room) return flat;
  const lower = flat.toLowerCase();
  const hits = words.map((word) => lower.indexOf(word.toLowerCase())).filter((at) => at >= 0);
  const first = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, first - Math.floor(room / 3));
  const end = Math.min(flat.length, start + room);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
