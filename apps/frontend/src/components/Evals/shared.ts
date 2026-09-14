import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  cancelRun, getRun, listCases, listModels, listRuns, startRun,
  type EvalRun,
} from '../../api/evals'

export const CASES_KEY = ['evals', 'cases']
export const RUNS_KEY = ['evals', 'runs']

export function useCases() {
  return useQuery({ queryKey: CASES_KEY, queryFn: listCases })
}

export function useModels() {
  return useQuery({ queryKey: ['evals', 'models'], queryFn: listModels })
}

export function useRuns() {
  return useQuery({ queryKey: RUNS_KEY, queryFn: listRuns })
}

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: ['evals', 'run', id],
    queryFn: () => getRun(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1500 : false),
  })
}

export function useStartRun(onStarted: (run: EvalRun) => void) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { repeats: number; only?: string[]; modelId?: string; modelLabel?: string }) =>
      startRun(input),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: RUNS_KEY })
      onStarted(run)
    },
  })
}

export function useCancelRun() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => cancelRun(id),
    onSuccess: () => client.invalidateQueries({ queryKey: RUNS_KEY }),
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
