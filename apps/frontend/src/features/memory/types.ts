import type { MemorySources } from './lib/memory-sources'

export type MemoryCategory = 'lessons_learned' | 'environment_facts' | 'prompt_guidance'
export type MemoryScope = 'project' | 'global'

export interface MemoryItem {
  id: string
  ownerId: string
  projectId?: string
  category: MemoryCategory
  model?: string
  scope?: MemoryScope
  recommendedScope?: MemoryScope
  status?: 'active' | 'pending_review'
  title: string
  text: string
  source?: 'manual' | 'agent_tool' | 'post_run_extractor'
  provenance?: {
    experimentId?: string
    taskId?: string
    toolId?: string
    sources?: MemorySources
  }
  createdAt: string
  updatedAt: string
  invalidAt?: string
  supersededBy?: string
  lastUsedAt?: string
  useCount?: number
}

export interface ConsolidationReport {
  at: string
  indexed: number
  deduped: number
  promoted: number
  decayed: number
  live: number
}
