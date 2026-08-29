
export const INPUTS_DIR = 'inputs';

export const REQUIRED_TOOL = 'read_file';

export const MAX_INLINE_INPUT_CHARS = 12_000;

export interface DependencyInput {
  leafId: string;
  title: string;
  findings: string;
}

export interface PreparedInput {
  path: string;
  title: string;
  chars: number;
  content: string;
}

export function inputPath(input: Pick<DependencyInput, 'leafId' | 'title'>): string {
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    || 'input';
  return `${INPUTS_DIR}/${slug}-${input.leafId.replace(/[^a-z0-9]/gi, '').slice(-6)}.md`;
}

export function prepareInputs(inputs: readonly DependencyInput[]): PreparedInput[] {
  return inputs
    .filter((i) => i.findings.trim())
    .map((i) => ({
      path: inputPath(i),
      title: i.title,
      chars: i.findings.trim().length,
      content: `# ${i.title}\n\n${i.findings.trim()}\n`,
    }));
}

export function buildInputIndex(prepared: readonly PreparedInput[], workspaceMount = '/work'): string {
  if (!prepared.length) return '';
  const lines = prepared.map((p) => `- ${p.title} — ${workspaceMount}/${p.path} (${p.chars.toLocaleString()} characters)`);
  return [
    'WHAT THE WORK THIS DEPENDS ON FOUND',
    '',
    'Their answers are FILES in your sandbox, not text in this prompt. Read them with `read_file`',
    'before you write anything — they are the inputs you are here to combine, and nothing in this',
    'prompt summarises them.',
    '',
    ...lines,
  ].join('\n');
}

export function buildInlineInputs(
  prepared: readonly PreparedInput[],
  budget = MAX_INLINE_INPUT_CHARS,
): string {
  if (!prepared.length) return '';
  const share = Math.floor(budget / prepared.length);

  const sections = prepared.map((p) => {
    const body = p.content.length <= share
      ? p.content
      : `${p.content.slice(0, share)}\n[truncated — ${(p.content.length - share).toLocaleString()} more characters were not shown]`;
    return body.trim();
  });

  return ['What the work this depends on already found:', '', ...sections].join('\n\n');
}
