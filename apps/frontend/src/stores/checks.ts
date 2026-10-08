import { create } from 'zustand'
import type { Scenario } from '../api/evals'

interface ChecksState {
  proposed: Scenario | null
  propose: (scenario: Scenario) => void
  clearProposed: () => void
}

export const useChecksStore = create<ChecksState>((set) => ({
  proposed: null,
  propose: (scenario) => set({ proposed: scenario }),
  clearProposed: () => set({ proposed: null }),
}))
