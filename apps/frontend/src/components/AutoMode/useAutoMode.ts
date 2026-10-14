import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { autoModeKeys, listAutoModeAgents, setAgentAutoMode, setTreeAutoMode } from '../../api/auto-mode'
import { groveKeys, listTrees } from '../../api/grove'

export interface AutoModeState {
  on: boolean | undefined
  switching: boolean
  error: unknown
  turn: (on: boolean) => void
}

export function useAgentAutoMode(slug: string): AutoModeState {
  const client = useQueryClient()
  const agents = useQuery({ queryKey: autoModeKeys.agents(), queryFn: listAutoModeAgents })
  const turn = useMutation({
    mutationFn: (on: boolean) => setAgentAutoMode(slug, on),
    onSuccess: (next) => client.setQueryData(autoModeKeys.agents(), next),
  })
  return { on: agents.data?.includes(slug), switching: turn.isPending, error: turn.error ?? agents.error, turn: (on) => turn.mutate(on) }
}

export function useTreeAutoMode(treeId: string): AutoModeState {
  const client = useQueryClient()
  const trees = useQuery({ queryKey: groveKeys.trees(), queryFn: listTrees })
  const turn = useMutation({
    mutationFn: (on: boolean) => setTreeAutoMode(treeId, on),
    onSuccess: () => client.invalidateQueries({ queryKey: groveKeys.trees() }),
  })
  const tree = trees.data?.find((entry) => entry.id === treeId)
  return { on: tree ? tree.autoMode === true : undefined, switching: turn.isPending, error: turn.error ?? trees.error, turn: (on) => turn.mutate(on) }
}
