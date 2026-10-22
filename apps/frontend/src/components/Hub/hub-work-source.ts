import type { QueryClient } from '@tanstack/react-query'
import { getHubBoard, getHubProcedure, hubKeys, listHubExtensions, readHubRunsUnder, sendHubRequest } from '../../api/hub'
import type { HubBoardView, HubRequestKind } from '../../types/hub'
import type { WorkSource } from '../../features/projects'
import { withOrder } from '../../features/projects'

export const HUB_BOARD_EVERY_MS = 3_000

export const hubProjectOf = (view: Pick<HubBoardView, 'project'>) => ({
  id: view.project.origin?.projectId ?? view.project.id,
  name: view.project.name,
  giteaOwner: '',
  giteaRepo: '',
})

const waitingOrders = (view: HubBoardView, kind: 'order-stories' | 'order-features'): string[][] =>
  view.requests
    .filter((request) => request.kind === kind && request.state === 'waiting')
    .map((request) => (request.input[kind === 'order-stories' ? 'leafIds' : 'branchIds'] as string[] | undefined) ?? [])

export const asOrdered = <T extends { id: string; priority?: number | undefined }>(items: T[], orders: readonly string[][]): T[] =>
  orders.reduce<T[]>((ordered, order) => withOrder(ordered, order), items)

export function hubWorkSource(client: QueryClient, view: HubBoardView): WorkSource {
  const id = view.project.id
  const board = () => client.fetchQuery({ queryKey: hubKeys.board(id), queryFn: () => getHubBoard(id), staleTime: HUB_BOARD_EVERY_MS - 500 })
  const ask = async (kind: HubRequestKind, input: Record<string, unknown>) => {
    await sendHubRequest(id, kind, input)
    await client.invalidateQueries({ queryKey: hubKeys.board(id) })
  }
  const changes = view.can.includes('approve-changes')
  const sees = view.can.includes('see-code')
  const owner = view.members.find((member) => member.personId === view.project.createdBy)
  return {
    key: ['hub', id],
    hub: {
      projectId: id,
      online: view.online,
      requests: view.requests,
      people: new Map(view.members.map((member) => [member.personId, member.email])),
      ownerEmail: owner?.email,
    },
    pushed: false,
    can: (power) => (power === 'change-work' ? changes : power === 'see-work' ? sees : false),
    listTrees: async () => (await board()).board.trees,
    listBranches: async () => {
      const fresh = await board()
      return asOrdered(fresh.board.branches, waitingOrders(fresh, 'order-features'))
    },
    listLeaves: async () => {
      const fresh = await board()
      return asOrdered(fresh.board.leaves, waitingOrders(fresh, 'order-stories'))
    },
    listProjects: async () => [hubProjectOf(await board())],
    listTasks: async () => (await board()).board.tasks,
    listTreePlans: async (treeId) => (await board()).board.planProposals.filter((proposal) =>
      proposal.leafPlan?.treeId === treeId || proposal.change?.treeId === treeId || proposal.plan?.treeId === treeId || proposal.adopted?.treeId === treeId),
    listReleases: async () => {
      const status = (await board()).board.status
      return { releases: status?.releases ?? [], addresses: status?.addresses ?? {} }
    },
    listProjectRuns: async () => (await board()).board.status?.runs ?? [],
    getTreeRun: async (treeId) => (await board()).board.status?.treeRuns[treeId] ?? { state: 'none' },
    readRunsUnder: (turnId, after, under) => readHubRunsUnder(id, turnId, after, under),
    getProcedure: (procedureId) => getHubProcedure(id, procedureId),
    listExtensions: () => listHubExtensions(id),
    orderStories: (branchId, leafIds) => ask('order-stories', { branchId, leafIds: [...leafIds] }),
    orderFeatures: (treeId, branchIds) => ask('order-features', { treeId, branchIds: [...branchIds] }),
    acceptTask: (taskId) => ask('accept-task', { taskId }),
    dropTask: (taskId) => ask('drop-task', { taskId }),
    fileScope: () => ({ kind: 'hub', projectId: id }),
  }
}
