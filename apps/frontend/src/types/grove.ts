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

export interface TreeType {
  id: string
  label: string
  summary: string
  usesRepo: boolean
  doneMeans: string
}
