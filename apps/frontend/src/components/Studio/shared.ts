import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery, keepPreviousData } from '@tanstack/react-query'
import type { GroupDefinition, NodeCategory, Procedure } from '@koala/agent-engine/procedure'
import {
  checkProcedureOnServer,
  deleteProcedure,
  getProcedure,
  getTrackRecords,
  listProcedures,
  procedureKeys,
  saveProcedure,
} from '../../api/procedures'
import {
  createExtension,
  deleteExtension,
  engineKeys,
  listEngineAgents,
  listExtensions,
  listRunTraces,
  publishOperation,
  removeOperation,
  setExtensionEnabled,
  updateExtension,
  type ExtensionBundle,
  type ExtensionDraft,
  type ExtensionSummary,
} from '../../api/engine'
import { canvasContextFor } from '../../lib/procedure-drafts'
import type { CanvasContext } from '../../lib/procedure-canvas'
import { agentKeys, deleteAgent, listAgents, listGrantableTools, saveAgent, type Agent } from '../../api/agents'
import { listMcpServers, mcpKeys, setMcpToolHint, type McpHintChoice } from '../../api/mcp'
import { egressKeys, listEgressGrants, revokeEgress } from '../../api/egress'
import {
  deleteEngineTool,
  engineToolKeys,
  listEngineTools,
  saveEngineTool,
  type EngineTool,
  type WorkspaceBuildFailure,
} from '../../api/engineTools'

import { errorMessage } from '../../api/client'

export { errorMessage }

const studioContextQuery = {
  queryKey: engineKeys.extensions(),
  queryFn: async (): Promise<CanvasContext> => canvasContextFor(await listExtensions()),
  staleTime: Infinity,
}

export function useStudioContextQuery() {
  return useQuery(studioContextQuery)
}

export function useExtensions() {
  return useQuery({ queryKey: [...engineKeys.extensions(), 'list'], queryFn: listExtensions })
}

export function useSwitchExtension(onRefused?: (message: string) => void) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setExtensionEnabled(id, enabled),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: engineKeys.extensions() })
      void client.invalidateQueries({ queryKey: agentKeys.all })
      void client.invalidateQueries({ queryKey: engineKeys.agents() })
    },
    onError: (err) => onRefused?.(errorMessage(err)),
  })
}

function useExtensionChange<A>(change: (args: A) => Promise<ExtensionSummary[]>, onRefused?: (message: string) => void) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: change,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: engineKeys.extensions() })
      void client.invalidateQueries({ queryKey: agentKeys.all })
      void client.invalidateQueries({ queryKey: engineKeys.agents() })
    },
    onError: (err) => onRefused?.(errorMessage(err)),
  })
}

export const useCreateExtension = (onRefused?: (message: string) => void) =>
  useExtensionChange((draft: ExtensionDraft) => createExtension(draft), onRefused)

export const useUpdateExtension = (onRefused?: (message: string) => void) =>
  useExtensionChange(({ id, bundle }: { id: string; bundle: ExtensionBundle }) => updateExtension(id, bundle), onRefused)

export const useDeleteExtension = (onRefused?: (message: string) => void) =>
  useExtensionChange((id: string) => deleteExtension(id), onRefused)

export const useRemoveOperation = (onRefused?: (message: string) => void) =>
  useExtensionChange(({ extension, name }: { extension: string; name: string }) => removeOperation(extension, name), onRefused)

export function usePublishOperation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ extension, name, group }: { extension: string; name: string; group: GroupDefinition }) => publishOperation(extension, name, group),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: engineKeys.extensions() })
      void client.invalidateQueries({ queryKey: procedureKeys.all() })
    },
  })
}

export function useStudioContext(): CanvasContext {
  return useSuspenseQuery(studioContextQuery).data
}

export const CATEGORY_COLOURS: Record<NodeCategory, string> = {
  input: '#94a3b8',
  context: '#7dd3fc',
  model: '#c4b5fd',
  tools: '#fda4af',
  environment: '#86efac',
  memory: '#5eead4',
  control: '#fcd34d',
  safety: '#fb923c',
  host: '#a3e635',
  custom: '#f0abfc',
}

export const CATEGORY_TITLES: Record<NodeCategory, string> = {
  input: 'Input',
  context: 'Context',
  model: 'Model',
  tools: 'Tools',
  environment: 'Environment',
  memory: 'Memory',
  control: 'Control',
  safety: 'Safety',
  host: 'Platform',
  custom: 'Groups',
}

export const PLACEMENT_TITLES: Record<string, string> = {
  workflow: 'runs inside the workflow, with no side effects',
  orchestration: 'runs inside the workflow and can wait on tools, people or other agents',
  activity: 'runs as a Temporal activity on the engine worker',
  stream: 'runs on the backend so it can stream to the browser',
  sandbox: 'runs inside the sandbox',
}

export const NODE_DRAG_TYPE = 'application/x-koala-node'

export function useAgents() {
  return useQuery({ queryKey: agentKeys.all, queryFn: listAgents })
}

export function useEgressGrants(agent: string) {
  const qc = useQueryClient()
  const grants = useQuery({ queryKey: egressKeys.grants(agent), queryFn: () => listEgressGrants(agent), enabled: Boolean(agent) })
  const revoke = useMutation({ mutationFn: (id: string) => revokeEgress(id), onSuccess: () => { void qc.invalidateQueries({ queryKey: egressKeys.all }) } })
  return { grants: grants.data ?? [], revoke: (id: string) => revoke.mutate(id), busy: revoke.isPending }
}

export function useMcpServerList() {
  return useQuery({ queryKey: mcpKeys.servers(), queryFn: listMcpServers })
}

export function useMcpToolHint() {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ server, tool, choice }: { server: string; tool: string; choice: McpHintChoice }) => setMcpToolHint(server, tool, choice),
    onSuccess: (servers) => { qc.setQueryData(mcpKeys.servers(), servers) },
  })
  return {
    choose: (server: string, tool: string, choice: McpHintChoice) => mutation.mutate({ server, tool, choice }),
    busy: mutation.isPending,
    error: mutation.error,
  }
}

export function useGrantableTools() {
  return useQuery({ queryKey: agentKeys.tools, queryFn: listGrantableTools })
}

export function useEngineTools() {
  return useQuery({ queryKey: engineToolKeys.all, queryFn: listEngineTools })
}

export function useSaveEngineTool(onSaved?: (outcome: { rebuilding: string[]; failed: WorkspaceBuildFailure[] }) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (tool: EngineTool) => saveEngineTool(tool),
    onSuccess: ({ rebuilding, failed }) => {
      void client.invalidateQueries({ queryKey: engineToolKeys.all })
      void client.invalidateQueries({ queryKey: agentKeys.all })
      onSaved?.({ rebuilding, failed })
    },
  })
}

export function useDeleteEngineTool(onDeleted?: () => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (name: string) => deleteEngineTool(name),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: engineToolKeys.all })
      void client.invalidateQueries({ queryKey: agentKeys.all })
      onDeleted?.()
    },
  })
}

export function useSaveAgent(onSaved?: (agent: Agent) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (agent: Agent) => saveAgent(agent),
    onSuccess: (agent) => {
      void client.invalidateQueries({ queryKey: agentKeys.all })
      onSaved?.(agent)
    },
  })
}

export function useDeleteAgent(onDeleted?: (slug: string) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (slug: string) => deleteAgent(slug),
    onSuccess: (_, slug) => {
      void client.invalidateQueries({ queryKey: agentKeys.all })
      onDeleted?.(slug)
    },
  })
}

export function useProcedureList() {
  return useQuery({ queryKey: procedureKeys.list(), queryFn: listProcedures })
}

export function useProcedure(id: string) {
  return useQuery({ queryKey: procedureKeys.one(id), queryFn: () => getProcedure(id), retry: false })
}

export function useTrackRecords(id: string) {
  return useQuery({ queryKey: procedureKeys.trackRecord(id), queryFn: () => getTrackRecords(id) })
}

export function useSaveProcedure() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: saveProcedure,
    onSuccess: (outcome) => {
      if (!outcome.saved) return
      client.setQueryData(procedureKeys.one(outcome.procedure.id), { procedure: outcome.procedure, mine: true })
      void client.invalidateQueries({ queryKey: procedureKeys.list() })
    },
  })
}

export function useDeleteProcedure() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: deleteProcedure,
    onSuccess: (_result, id) => {
      void client.invalidateQueries({ queryKey: procedureKeys.list() })
      void client.invalidateQueries({ queryKey: procedureKeys.one(id) })
    },
  })
}

function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

export function useServerProblems(procedure: Procedure) {
  const settled = useSettled(procedure, 700)
  const source = JSON.stringify(settled)
  const query = useQuery({
    queryKey: [...procedureKeys.all(), 'check', source],
    queryFn: () => checkProcedureOnServer(settled),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })
  const current = settled === procedure && !query.isPlaceholderData
  return { problems: current ? query.data : undefined, checking: query.isFetching || settled !== procedure }
}

export function useEngineAgents() {
  return useQuery({ queryKey: engineKeys.agents(), queryFn: listEngineAgents })
}

export function useRunTraces(runId: string | undefined, finished: boolean) {
  return useQuery({
    queryKey: engineKeys.traces(runId ?? ''),
    queryFn: () => listRunTraces(runId!),
    enabled: Boolean(runId) && finished,
  })
}
