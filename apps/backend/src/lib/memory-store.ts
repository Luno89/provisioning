export interface MemoryItem {
  id: string;
  ownerId: string;
  projectId?: string;
  category: 'lessons_learned' | 'environment_facts' | 'prompt_guidance';
  scope?: 'project' | 'global';
  recommendedScope?: 'project' | 'global';
  status?: 'active' | 'pending_review';
  title: string;
  text: string;
  source?: 'manual' | 'agent_tool' | 'post_run_extractor';
  provenance?: {
    experimentId?: string;
    taskId?: string;
    toolId?: string;
  };
  createdAt: string;
  updatedAt: string;

  /**
   * ── BI-TEMPORAL: WHEN IT WAS TRUE, NOT JUST WHEN IT WAS WRITTEN ──
   *
   * A memory that stops being true is INVALIDATED, never deleted. `supersede` used to call
   * `db.deleteMemory` on the previous "Repository layout" fact, which made one question
   * unanswerable: what did the harness believe when THIS leaf ran? Failure review and the judge
   * both read a finished leaf and ask exactly that, and the row was gone.
   *
   * Keeping it costs a filter clause and makes every correction reversible — which is also what
   * lets a model decide what to store (memory-decide.ts) without a human gate in front of it. A
   * wrong DELETE is a field to clear, not information destroyed.
   */
  /** When the fact became true. Defaults to `createdAt` where absent. */
  validAt?: string;
  /** When it stopped being true. Absent means current — this is the field recall filters on. */
  invalidAt?: string;
  /** The memory that replaced this one, when it was superseded rather than merely retired. */
  supersededBy?: string;

  /**
   * Retrieval history, written by `memory-recall.ts` when a memory is actually selected.
   *
   * This is what makes decay usage-based rather than age-based: an old fact that keeps being
   * selected is load-bearing, and a recent one nothing ever matches is noise. Age alone cannot tell
   * those apart.
   */
  lastUsedAt?: string;
  useCount?: number;
}

/**
 * The most this may contribute to a prompt.
 *
 * ── WHY IT NEEDS A CEILING AT ALL ──
 * This text is baked into the SYSTEM prompt (agent-loop.ts), which puts it OUTSIDE the region
 * `trimConversation` is allowed to touch. So it is the one part of a prompt that only ever grows:
 * every run that finishes extracts a memory, every memory joins every future prompt, and nothing
 * ever drops one. A conversation trimmer working hard on the messages while the system prompt
 * quietly expands underneath it is fixing the wrong half — and phase checkpoints, which reset the
 * conversation and keep the system prompt, would inherit exactly that.
 *
 * Roughly 10% of CONVERSATION_CHAR_BUDGET. Memory is context the agent did not ask for; it should
 * cost a tenth of what the work itself gets, not compete with it.
 */
export const MAX_MEMORY_CONTEXT_CHARS = 6000;

/**
 * One rendered bullet. Kept together with the selection so the budget counts what is emitted.
 *
 * Whitespace is collapsed, and that is not cosmetic. The bank is a list of bullets, and a memory
 * whose text contains newlines silently becomes several — a promoted research finding is markdown,
 * headings and all, and one of them turned a five-entry bank into what read as twenty entries, most
 * of them fragments beginning mid-sentence. An agent reading that cannot tell where one memory ends
 * and the next begins.
 */
const lineFor = (m: MemoryItem) => `- ${m.title}: ${m.text.replace(/\s+/g, ' ').trim()}`;

/**
 * Which memories to spend the budget on, best first.
 *
 * Project-scoped beats global because it is the more specific claim: "this repo's tests need a
 * live Postgres" is worth more to the leaf in front of you than a general note. Within each, newest
 * first — a fact re-extracted last week describes the current repository, and the one it superseded
 * describes a layout that has since changed.
 */
export function ranked(memories: MemoryItem[]): MemoryItem[] {
  return [...memories].sort((a, b) => {
    const scopeRank = (m: MemoryItem) => (m.scope === 'project' ? 0 : 1);
    if (scopeRank(a) !== scopeRank(b)) return scopeRank(a) - scopeRank(b);
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

export interface MemoryContextOptions {
  /**
   * The caller already ordered these by relevance, so do not re-sort by scope and date.
   *
   * `memory-recall.ts` ranks by hybrid search; `ranked()` below ranks by scope then recency. The
   * second is the fallback used whenever search is unavailable, which is why both survive — but
   * applying it on top of a relevance ordering would throw that ordering away, which is the whole
   * of what recall bought.
   */
  preRanked?: boolean;
}

/**
 * Which memories fit, and how many did not.
 *
 * Split out of `buildMemoryContext` so `memory-recall.ts` can know exactly WHICH entries reached
 * the prompt — that is what `lastUsedAt` records, and it has to be what was actually injected
 * rather than what was merely retrieved. Decay is built on that distinction: a memory the search
 * keeps finding but the budget keeps cutting has not been used.
 */
export function selectForContext(
  memories: MemoryItem[],
  projectId?: string,
  opts: MemoryContextOptions = {},
): { kept: MemoryItem[]; dropped: number } {
  if (!memories.length) return { kept: [], dropped: 0 };

  /**
   * Active memories that apply to THIS leaf.
   *
   * ── THE LEAK ──
   * The project branch used to read `!projectId || m.projectId === projectId`, so a leaf with NO
   * project matched every project-scoped memory in the bank. Every `repo: false` persona —
   * Researcher, Framer, Synthesist, Reviewer, Judge — resolves no project, so that was most of them.
   *
   * Measured on this instance when the cap was added: 125 memories, all project-scoped, 18 of them
   * active — and all 18 were "Repository layout", one per project, correctly superseded. So a
   * research leaf opened every prompt with eighteen unrelated repositories' file listings presented
   * as environment facts. Not merely wasteful: it is a confident description of a codebase the leaf
   * is not working in.
   *
   * A memory scoped to a project cannot apply to a leaf that has none. The answer is false.
   */
  const activeMemories = memories.filter((m) => {
    if (m.status === 'pending_review') return false;
    // Superseded or retired. The row is kept so history is answerable; it is not current, so it
    // does not describe the repository the leaf is standing in.
    if (m.invalidAt) return false;
    if (!m.scope || m.scope === 'global') return true;
    if (m.scope === 'project') return Boolean(projectId) && m.projectId === projectId;
    return true;
  });

  if (!activeMemories.length) return { kept: [], dropped: 0 };

  /**
   * Selected against the budget BEFORE grouping, so what gets dropped is the least useful memory
   * rather than whichever category happens to be rendered last.
   */
  const kept: MemoryItem[] = [];
  let used = 0;
  for (const m of (opts.preRanked ? activeMemories : ranked(activeMemories))) {
    const cost = lineFor(m).length + 1;
    if (used + cost > MAX_MEMORY_CONTEXT_CHARS) continue;
    kept.push(m);
    used += cost;
  }

  return { kept, dropped: activeMemories.length - kept.length };
}

/** The bank as it appears in a system prompt. */
export function renderMemoryContext(kept: MemoryItem[], dropped: number): string {
  // Everything was too large to fit even one entry: say so rather than returning an empty bank,
  // which reads as "there is nothing to know".
  if (!kept.length) {
    return dropped > 0
      ? `HARNESS MEMORY BANK:\n(${dropped} entries omitted — each is larger than the context budget for memory.)`
      : '';
  }

  const lessons = kept.filter((m) => m.category === 'lessons_learned');
  const facts = kept.filter((m) => m.category === 'environment_facts');
  const guidance = kept.filter((m) => m.category === 'prompt_guidance');

  const sections: string[] = ['HARNESS MEMORY BANK:'];

  if (lessons.length) {
    sections.push('💡 Lessons Learned (Avoid repeat mistakes):');
    lessons.forEach((m) => sections.push(lineFor(m)));
  }

  if (facts.length) {
    sections.push('📌 Environment & System Facts:');
    facts.forEach((m) => sections.push(lineFor(m)));
  }

  if (guidance.length) {
    sections.push('📜 Persistent Prompt Guidance:');
    guidance.forEach((m) => sections.push(lineFor(m)));
  }

  /**
   * The elision is stated, not silent.
   *
   * An agent that is told it has a memory bank, and is quietly given a truncated one, will
   * confidently report that something is not recorded when it is. Saying the number costs one line
   * and turns a wrong answer into a checkable one.
   */
  if (dropped > 0) {
    sections.push(`(${dropped} older ${dropped === 1 ? 'entry' : 'entries'} not shown — ask if you need more.)`);
  }

  return sections.join('\n');
}

export function buildMemoryContext(
  memories: MemoryItem[],
  projectId?: string,
  opts: MemoryContextOptions = {},
): string {
  const { kept, dropped } = selectForContext(memories, projectId, opts);
  return renderMemoryContext(kept, dropped);
}
