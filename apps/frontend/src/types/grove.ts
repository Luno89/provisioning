import type { Leaf } from '../components/leaf-types'

export type { Leaf }

export interface Tree {
  id: string
  name: string
  type: string
  goal?: string
  branchCount: number
  updatedAt: string
}

export interface Branch {
  id: string
  title: string
  treeId?: string
  ownerId?: string
  createdAt?: string
  updatedAt?: string
}

export interface TreeTypeFile {
  path: string
  content: string
  executable?: boolean | undefined
}

export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base'

export interface PersonaEgressRule {
  cidr?: string | undefined
  namespace?: string | undefined
  ports?: number[] | undefined
}

/**
 * Which agent runs each stage of a tree of this type. A stage left unnamed falls back to the default
 * in `apps/backend/src/lib/grove-stages.ts` — the type is as specific or as flexible as its author
 * wants. (`deliver` joins these when landing does.)
 */
export interface TreeStages {
  plan?: string | undefined
  work?: string | undefined
  judge?: string | undefined
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `TreeTypeSpec` in `apps/backend/src/lib/tree-types.ts`, which is the authority. Kept in
 * sync by hand — there is no shared package between the two halves for this shape.
 */
export interface TreeType {
  id: string
  ownerId?: string | undefined
  label: string
  summary: string
  language: WorkspaceLanguage
  produces: 'service' | 'artefact'
  doneMeans: string
  requireSources?: boolean | undefined
  files: TreeTypeFile[]
  defaultBindings?: string[] | undefined
  egress?: PersonaEgressRule[] | undefined
  env?: { name: string; value: string }[] | undefined
  stages?: TreeStages | undefined
}
