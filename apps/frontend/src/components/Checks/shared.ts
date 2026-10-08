import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  cancelLevel2Run,
  compareCheckRuns,
  getCoverage,
  getCheckProcedure,
  deleteScenario,
  acceptProposal,
  dismissProposal,
  getBench,
  getLevel2Run,
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
  saveScenario,
  startLevel2Run,
  type BenchSettings,
  type Level2Run,
  type Scenario,
  type StartLevel2Input,
} from '../../api/evals'

export const evalKeys = {
  comparison: (before: string, after: string) => ['evals', 'level2', 'compare', before, after] as const,
  coverage: ['evals', 'level2', 'coverage'] as const,
  checkProcedure: (id: string) => ['evals', 'level2', 'procedure', id] as const,
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

export function useCoverage() {
  return useQuery({ queryKey: evalKeys.coverage, queryFn: getCoverage })
}

export function useCheckProcedure(scenarioId: string, enabled: boolean) {
  return useQuery({ queryKey: evalKeys.checkProcedure(scenarioId), queryFn: () => getCheckProcedure(scenarioId), enabled, retry: false })
}

export function useComparison(before: string | undefined, after: string | undefined) {
  return useQuery({
    queryKey: evalKeys.comparison(before ?? '', after ?? ''),
    queryFn: () => compareCheckRuns(before!, after!),
    enabled: Boolean(before && after && before !== after),
  })
}

export function useScenarios() {
  return useQuery({ queryKey: evalKeys.scenarios, queryFn: listScenarios })
}

export function useLevel2Runs() {
  return useQuery({
    queryKey: evalKeys.level2Runs,
    queryFn: listLevel2Runs,
    refetchInterval: (query) => ((query.state.data ?? []).some((run) => run.state === 'running') ? 2000 : false),
  })
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
      void client.invalidateQueries({ queryKey: evalKeys.coverage })
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
    void client.invalidateQueries({ queryKey: evalKeys.coverage })
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
      void client.invalidateQueries({ queryKey: evalKeys.coverage })
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

export const panelClass = 'rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/60 p-4'
export const fieldClass = 'rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-[var(--leaf-stem)]'
export const primaryButton = 'rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-3 py-1.5 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/30 disabled:opacity-40'
export const quietButton = 'rounded-md border border-[var(--bark-600)] px-3 py-1.5 text-xs text-slate-300 hover:bg-[var(--bark-700)] disabled:opacity-40'

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
  switch (trigger.kind) {
    case 'full': return 'bench, everything'
    case 'changed': return `bench, changed ${trigger.agents.join(', ')}`
    case 'practice': return `bench, trying a practice for ${trigger.agent}`
    case 'prompt-change': return `bench, comparing a prompt for ${trigger.agent}`
  }
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
