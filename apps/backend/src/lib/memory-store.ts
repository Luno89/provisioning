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
}

export function buildMemoryContext(memories: MemoryItem[], projectId?: string): string {
  if (!memories.length) return '';

  // Only include active memories matching global scope or current project scope
  const activeMemories = memories.filter((m) => {
    if (m.status === 'pending_review') return false;
    if (!m.scope || m.scope === 'global') return true;
    if (m.scope === 'project') return !projectId || m.projectId === projectId;
    return true;
  });

  if (!activeMemories.length) return '';

  const lessons = activeMemories.filter((m) => m.category === 'lessons_learned');
  const facts = activeMemories.filter((m) => m.category === 'environment_facts');
  const guidance = activeMemories.filter((m) => m.category === 'prompt_guidance');

  const sections: string[] = ['HARNESS MEMORY BANK:'];

  if (lessons.length) {
    sections.push('💡 Lessons Learned (Avoid repeat mistakes):');
    lessons.forEach((m) => sections.push(`- ${m.title}: ${m.text}`));
  }

  if (facts.length) {
    sections.push('📌 Environment & System Facts:');
    facts.forEach((m) => sections.push(`- ${m.title}: ${m.text}`));
  }

  if (guidance.length) {
    sections.push('📜 Persistent Prompt Guidance:');
    guidance.forEach((m) => sections.push(`- ${m.title}: ${m.text}`));
  }

  return sections.join('\n');
}
