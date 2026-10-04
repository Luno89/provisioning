import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  cancelLevel1Run,
  cancelLevel2Run,
  compareLevel1Runs,
  deleteCase,
  deleteScenario,
  acceptProposal,
  dismissProposal,
  getBench,
  getLevel1Run,
  getLevel2Run,
  getPrompt,
  listCases,
  listLevel1Runs,
  listLevel2Runs,
  listProposals,
  listPractices,
  listChanges,
  acceptChange,
  handOverChange,
  dismissChange,
  makePracticeLive,
  retirePractice,
  listModels,
  listScenarios,
  saveBench,
  saveCase,
  saveScenario,
  startLevel1Run,
  startLevel2Run,
  type BenchSettings,
  type EvalCase,
  type Level1Run,
  type Level2Run,
  type Scenario,
  type StartLevel1Input,
  type StartLevel2Input,
} from '../../api/evals'

export const evalKeys = {
  cases: ['evals', 'level1', 'cases'] as const,
  level1Runs: ['evals', 'level1', 'runs'] as const,
  level1Run: (id: string) => ['evals', 'level1', 'run', id] as const,
  prompt: (hash: string) => ['evals', 'level1', 'prompt', hash] as const,
  comparison: (before: string, after: string) => ['evals', 'level1', 'compare', before, after] as const,
  scenarios: ['evals', 'level2', 'scenarios'] as const,
  level2Runs: ['evals', 'level2', 'runs'] as const,
  level2Run: (id: string) => ['evals', 'level2', 'run', id] as const,
  models: ['evals', 'models'] as const,
  bench: ['evals', 'level2', 'bench'] as const,
  proposals: ['evals', 'level2', 'proposals'] as const,
  practices: ['evals', 'level2', 'practices'] as const,
  changes: ['evals', 'level2', 'changes'] as const,
}

const whileRunning = (state: string | undefined, every: number) => (state === 'running' ? every : false)

export function useModels() {
  return useQuery({ queryKey: evalKeys.models, queryFn: listModels })
}

export function useCases() {
  return useQuery({ queryKey: evalKeys.cases, queryFn: listCases })
}

export function useLevel1Runs() {
  return useQuery({ queryKey: evalKeys.level1Runs, queryFn: listLevel1Runs })
}

export function useLevel1Run(id: string | undefined) {
  return useQuery({
    queryKey: evalKeys.level1Run(id ?? ''),
    queryFn: () => getLevel1Run(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => whileRunning(query.state.data?.state, 1500),
  })
}

export function useStartLevel1Run(onStarted: (run: Level1Run) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: StartLevel1Input) => startLevel1Run(input),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: evalKeys.level1Runs })
      onStarted(run)
    },
  })
}

export function useCancelLevel1Run() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => cancelLevel1Run(id),
    onSuccess: () => client.invalidateQueries({ queryKey: evalKeys.level1Runs }),
  })
}

export function useSaveCase(onSaved?: (entry: EvalCase) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (entry: EvalCase) => saveCase(entry),
    onSuccess: (entry) => {
      void client.invalidateQueries({ queryKey: evalKeys.cases })
      onSaved?.(entry)
    },
  })
}

export function useDeleteCase(onDeleted?: (name: string) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (name: string) => deleteCase(name),
    onSuccess: (_, name) => {
      void client.invalidateQueries({ queryKey: evalKeys.cases })
      onDeleted?.(name)
    },
  })
}

export function usePrompt(hash: string | undefined) {
  return useQuery({
    queryKey: evalKeys.prompt(hash ?? ''),
    queryFn: () => getPrompt(hash!),
    enabled: Boolean(hash),
  })
}

export function useComparison(before: string | undefined, after: string | undefined) {
  return useQuery({
    queryKey: evalKeys.comparison(before ?? '', after ?? ''),
    queryFn: () => compareLevel1Runs(before!, after!),
    enabled: Boolean(before && after && before !== after),
  })
}

export function useScenarios() {
  return useQuery({ queryKey: evalKeys.scenarios, queryFn: listScenarios })
}

export function useLevel2Runs() {
  return useQuery({ queryKey: evalKeys.level2Runs, queryFn: listLevel2Runs })
}

export function useLevel2Run(id: string | undefined) {
  return useQuery({
    queryKey: evalKeys.level2Run(id ?? ''),
    queryFn: () => getLevel2Run(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => whileRunning(query.state.data?.state, 1200),
  })
}

export function useStartLevel2Run(onStarted: (run: Level2Run) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: StartLevel2Input) => startLevel2Run(input),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: evalKeys.level2Runs })
      onStarted(run)
    },
  })
}

export function useCancelLevel2Run() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => cancelLevel2Run(id),
    onSuccess: () => client.invalidateQueries({ queryKey: evalKeys.level2Runs }),
  })
}

export function useSaveScenario(onSaved?: (scenario: Scenario) => void, saveWith?: (scenario: Scenario) => Promise<Scenario>) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (scenario: Scenario) => (saveWith ?? saveScenario)(scenario),
    onSuccess: (scenario) => {
      void client.invalidateQueries({ queryKey: evalKeys.scenarios })
      void client.invalidateQueries({ queryKey: evalKeys.proposals })
      onSaved?.(scenario)
    },
  })
}

export function useProposals() {
  return useQuery({ queryKey: evalKeys.proposals, queryFn: listProposals })
}

export function useDecideProposal() {
  const client = useQueryClient()
  const settle = () => {
    void client.invalidateQueries({ queryKey: evalKeys.proposals })
    void client.invalidateQueries({ queryKey: evalKeys.scenarios })
  }
  const accept = useMutation({ mutationFn: (id: string) => acceptProposal(id), onSuccess: settle })
  const dismiss = useMutation({ mutationFn: (id: string) => dismissProposal(id), onSuccess: settle })
  return { accept, dismiss }
}

export function useDeleteScenario(onDeleted?: (id: string) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteScenario(id),
    onSuccess: (_, id) => {
      void client.invalidateQueries({ queryKey: evalKeys.scenarios })
      onDeleted?.(id)
    },
  })
}

export function useSelection(all: string[]) {
  const [excluded, setExcluded] = useState<string[]>([])

  const isChosen = (name: string) => !excluded.includes(name)

  return {
    isChosen,
    chosen: all.filter(isChosen),
    everything: all.length > 0 && excluded.length === 0,
    toggle: (name: string) =>
      setExcluded((current) => (current.includes(name)
        ? current.filter((entry) => entry !== name)
        : [...current, name])),
    all: () => setExcluded([]),
    none: () => setExcluded(all),
  }
}

export const CATEGORY_LABEL: Record<string, string> = {
  simple: 'one call',
  multiple: 'picks from several',
  irrelevance: 'should call nothing',
}

export const panelClass = 'rounded border border-slate-800 bg-slate-900/40 p-4'
export const fieldClass = 'rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100 placeholder:text-slate-600'
export const primaryButton = 'rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40'
export const quietButton = 'rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 disabled:opacity-40'

export function useBench() {
  return useQuery({ queryKey: evalKeys.bench, queryFn: getBench })
}

export function useSaveBench() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (settings: BenchSettings) => saveBench(settings),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: evalKeys.bench }) },
  })
}

export function triggerLabel(trigger: Level2Run['trigger']): string {
  if (!trigger || trigger.kind === 'manual') return 'by hand'
  if (trigger.kind === 'full') return 'bench, everything'
  return `bench, changed ${trigger.agents.join(', ')}`
}

export function usePractices() {
  return useQuery({ queryKey: evalKeys.practices, queryFn: listPractices })
}

export function useDecidePractice() {
  const client = useQueryClient()
  const settle = () => { void client.invalidateQueries({ queryKey: evalKeys.practices }) }
  const live = useMutation({ mutationFn: (id: string) => makePracticeLive(id), onSuccess: settle })
  const retire = useMutation({ mutationFn: (id: string) => retirePractice(id), onSuccess: settle })
  return { live, retire }
}

export function useChanges() {
  return useQuery({ queryKey: evalKeys.changes, queryFn: listChanges, refetchInterval: 15_000, refetchIntervalInBackground: true })
}

export function useDecideChange(onHandedOver?: (conversationId: string) => void) {
  const client = useQueryClient()
  const settle = () => { void client.invalidateQueries({ queryKey: evalKeys.changes }) }
  const accept = useMutation({ mutationFn: ({ id, prompt }: { id: string; prompt?: string }) => acceptChange(id, prompt), onSuccess: settle })
  const handOver = useMutation({
    mutationFn: (id: string) => handOverChange(id),
    onSuccess: (change) => { settle(); if (change.conversationId) onHandedOver?.(change.conversationId) },
  })
  const dismiss = useMutation({ mutationFn: (id: string) => dismissChange(id), onSuccess: settle })
  return { accept, handOver, dismiss }
}
