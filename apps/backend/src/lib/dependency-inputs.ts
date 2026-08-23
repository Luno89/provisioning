/**
 * Handing a leaf what its dependencies produced.
 *
 * ── WHY BY REFERENCE ──
 * These used to be concatenated into `taskContext`, which becomes the SYSTEM prompt — the one region
 * `trimConversation` may not touch, so it can never be reclaimed. Cost was `O(N × size)`: a
 * Synthesist with four dependencies carried 64,807 characters, about 16,200 tokens, before the
 * environment description, the memory bank, or a single turn.
 *
 * That was survivable on a 131K model and fatal on a 32K one, and fatal again at 131K once N reaches
 * twenty. A platform meant to run several models at once — some of them small — cannot have a
 * handoff whose cost depends on the window. Passing a path instead makes the prompt cost constant:
 * roughly two hundred tokens whether there are four inputs or forty, on any model.
 *
 * ── WHICH IS HOW CODE LEAVES HAVE ALWAYS WORKED ──
 * A Builder gets a checkout and reads what it needs; nobody pastes the repository into its prompt.
 * `ExecuteLeafActivity` already calls findings "the same guarantee, different carrier" as a branch.
 * This makes the carrier the same too, and puts the agent in charge of what it spends context on —
 * which is what tools are for.
 */

/** Where inputs land. Inside the workspace mount, so it survives exactly as long as the sandbox. */
export const INPUTS_DIR = 'inputs';

/** The tool a persona needs before inputs can be given as files rather than as text. */
export const REQUIRED_TOOL = 'read_file';

/**
 * The most inline text a leaf may be given when it CANNOT read files.
 *
 * One budget shared across every dependency, not a cap per item. A per-item cap with no total is
 * exactly the shape that let four 20,000-character findings become 64,807 — the same bug the memory
 * bank had before `MAX_MEMORY_CONTEXT_CHARS`.
 */
export const MAX_INLINE_INPUT_CHARS = 12_000;

export interface DependencyInput {
  leafId: string;
  title: string;
  findings: string;
}

export interface PreparedInput {
  /** Path relative to the workspace root, e.g. `inputs/research-mem0.md`. */
  path: string;
  title: string;
  chars: number;
  content: string;
}

/**
 * A filename from a leaf title, stable and collision-free.
 *
 * The leaf id is the suffix rather than the whole name because a directory listing is something the
 * agent reads: `research-mem0-pipeline-a1b2c3.md` says what it is, `a1b2c3.md` does not.
 */
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
      // Titled, so a file read in isolation still says what question it answers.
      content: `# ${i.title}\n\n${i.findings.trim()}\n`,
    }));
}

/**
 * The index that goes in the prompt — what exists and where, never the contents.
 *
 * Sizes are stated because they are what an agent needs to plan around: a 20,000-character input is
 * a decision about how much of a budget to spend, and an agent that cannot see the size will either
 * read everything or guess.
 */
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

/**
 * The fallback for a persona with no `read_file`, sharing one budget across all inputs.
 *
 * Equal shares rather than first-come: an agent given all of input one and none of input four cannot
 * tell that four existed. Truncation is stated per input for the same reason the memory bank says
 * how many entries it dropped — an agent handed a quietly cut document will summarise it as though
 * it were whole.
 */
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
