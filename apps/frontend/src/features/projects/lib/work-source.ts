import { createContext, useContext } from 'react'
import type { QueryKey } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { listBranches, listLeaves, listTrees, getTreeRun, orderFeatures, orderStories, type TreeRunStatus } from '../api/grove'
import { acceptTask, dropTask, listExtensions, listTasks, type EngineTask, type ExtensionSummary } from '../../../api/engine'
import { listReleases, type ReleaseList } from '../../releases'
import { listProjectRuns, listProjects } from '../api/projects'
import { readRunsUnder } from '../../../api/turns'
import { getProcedure } from '../../../api/procedures'
import { listTreePlans } from '../api/plans'
import type { PlanProposal } from '@koala/harness-types'
import type { Branch } from '../types/grove'
import type { FileScope } from '../../files'
import type { HubRequest } from '../../hub'
import type { TurnLogEntry } from '../../../types/turns'
import type { Leaf } from './leaf-types'
import type { PipelineRun } from '../components/PipelineRunRow'
import type { LinkedProject } from '../components/Workspace/BuildsDeploysPanel'
import type { WorkTree } from '../hooks/useProjectWork'
import type { Procedure } from '@koala/agent-engine/procedure'

export type WorkPower = 'change-work' | 'see-work' | 'run-work' | 'delete-work' | 'threads' | 'story-code'

export interface HubPlace {
  projectId: string
  online: boolean
  requests: HubRequest[]
  people: ReadonlyMap<string, string>
  ownerEmail?: string | undefined
}

export type BoardChat = { kind: 'channel' } | { kind: 'story' | 'feature'; id: string; title: string }

export interface WorkSource {
  key: readonly unknown[]
  hub?: HubPlace | undefined
  chat?: ((chat: BoardChat) => ReactNode) | undefined
  pushed: boolean
  can(power: WorkPower): boolean
  listTrees(): Promise<WorkTree[]>
  listBranches(): Promise<Branch[]>
  listLeaves(): Promise<Leaf[]>
  listProjects(): Promise<LinkedProject[]>
  listTasks(): Promise<EngineTask[]>
  listTreePlans(treeId: string): Promise<PlanProposal[]>
  listReleases(projectId: string): Promise<ReleaseList>
  listProjectRuns(projectId: string): Promise<PipelineRun[]>
  getTreeRun(treeId: string): Promise<TreeRunStatus>
  readRunsUnder(turnId: string, after: number, under: string): Promise<{ entries: TurnLogEntry[]; through: number }>
  getProcedure(id: string): Promise<{ procedure: Procedure; mine: boolean }>
  listExtensions(): Promise<ExtensionSummary[]>
  orderStories(branchId: string, leafIds: readonly string[]): Promise<void>
  orderFeatures(treeId: string, branchIds: readonly string[]): Promise<void>
  acceptTask(taskId: string): Promise<void>
  dropTask(taskId: string): Promise<void>
  fileScope(projectId: string): FileScope
}

export const localWorkSource: WorkSource = {
  key: [],
  pushed: true,
  can: () => true,
  listTrees: () => listTrees() as Promise<WorkTree[]>,
  listBranches,
  listLeaves,
  listProjects: () => listProjects<LinkedProject>(),
  listTasks,
  listTreePlans,
  listReleases,
  listProjectRuns: (projectId) => listProjectRuns<PipelineRun>(projectId),
  getTreeRun,
  readRunsUnder,
  getProcedure,
  listExtensions,
  orderStories,
  orderFeatures,
  acceptTask,
  dropTask,
  fileScope: (projectId) => ({ kind: 'project', projectId }),
}

export const WorkSourceContext = createContext<WorkSource>(localWorkSource)

export const useWorkSource = (): WorkSource => useContext(WorkSourceContext)

export const keyedBy = (source: Pick<WorkSource, 'key'>, key: QueryKey): QueryKey => (source.key.length ? [...source.key, ...key] : key)
