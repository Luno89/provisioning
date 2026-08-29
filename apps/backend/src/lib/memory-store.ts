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

  validAt?: string;
  invalidAt?: string;
  supersededBy?: string;

  lastUsedAt?: string;
  useCount?: number;
}

export const MAX_MEMORY_CONTEXT_CHARS = 6000;

const lineFor = (m: MemoryItem) => `- ${m.title}: ${m.text.replace(/\s+/g, ' ').trim()}`;

export function ranked(memories: MemoryItem[]): MemoryItem[] {
  return [...memories].sort((a, b) => {
    const scopeRank = (m: MemoryItem) => (m.scope === 'project' ? 0 : 1);
    if (scopeRank(a) !== scopeRank(b)) return scopeRank(a) - scopeRank(b);
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

export interface MemoryContextOptions {
  preRanked?: boolean;
}

export function selectForContext(
  memories: MemoryItem[],
  projectId?: string,
  opts: MemoryContextOptions = {},
): { kept: MemoryItem[]; dropped: number } {
  if (!memories.length) return { kept: [], dropped: 0 };

  const activeMemories = memories.filter((m) => {
    if (m.status === 'pending_review') return false;
    if (m.invalidAt) return false;
    if (!m.scope || m.scope === 'global') return true;
    if (m.scope === 'project') return Boolean(projectId) && m.projectId === projectId;
    return true;
  });

  if (!activeMemories.length) return { kept: [], dropped: 0 };

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

export function renderMemoryContext(kept: MemoryItem[], dropped: number): string {
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

export function unreachableMemory(item: MemoryItem): string | undefined {
  if (item.scope === 'project' && !item.projectId) {
    return 'A project-scoped memory needs a projectId, or it can never be recalled — '
      + 'set projectId, or use scope "global".';
  }
  return undefined;
}
