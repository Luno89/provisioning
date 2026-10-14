import type { Leaf } from '../components/leaf-types'

export type { Leaf }

export interface Tree {
  id: string
  name: string
  type: string
  version?: string
  goal?: string
  autoMode?: boolean
  branchCount: number
  updatedAt: string
}

export interface Branch {
  id: string
  title: string
  treeId?: string
  priority?: number
  ownerId?: string
  createdAt?: string
  updatedAt?: string
}

export interface TreeTypeFile {
  path: string
  content: string
  executable?: boolean | undefined
}

export type WorkspaceLanguage = 'node' | 'python' | 'go' | 'base' | 'odoo' | 'odoo-20'

export interface PersonaEgressRule {
  cidr?: string | undefined
  namespace?: string | undefined
  ports?: number[] | undefined
}

export type TreeTypeSecretSource = 'generated' | 'gitea-read-token' | 'person'

export interface TreeTypeSecret {
  key: string
  source: TreeTypeSecretSource
  describe: string
  signInAs?: string | undefined
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
  secrets?: TreeTypeSecret[] | undefined
  releaseWhen?: string[] | undefined
  agent?: string | undefined
  versions?: TreeTypeVersions | undefined
}

export interface TreeTypeVersions {
  of: string
  choices: { version: string; language: WorkspaceLanguage }[]
  default: string
}
