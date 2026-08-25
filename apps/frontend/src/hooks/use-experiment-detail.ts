import { useQuery } from '@tanstack/react-query'
import { getExperiment, experimentKeys } from '../api/harness'
import type { Experiment as ExperimentDetail } from '@koala/harness-types'

/**
 * ── WHY THIS IS A HOOK FILE AND NOT PART OF `api/harness` ──
 * It lived beside `getExperiment` in that module, and a module mock could not reach it: mocking
 * `../api/harness` replaces the module's EXPORTS, but a function calling its own sibling inside
 * the same file binds the real one. So `vi.mock('../api/harness')` left this hook fetching for
 * real, and 48 Lab tests failed on data that never arrived — with no indication that the mock was
 * the thing not working.
 *
 * The split is the right shape anyway, and the plan already called for it: `api/` is transport,
 * `hooks/` is the react-query wrapping around it. Anything in `api/` that needs React belongs
 * here.
 */

/**
 * The full record for one experiment, fetched only when it is needed.
 *
 * `enabled` is the whole point: mounting this for every card would restore the payload problem it
 * exists to solve, so it stays idle until a panel is actually opened.
 */
export function useExperimentDetail(id: string, enabled: boolean) {
  return useQuery<ExperimentDetail>({
    queryKey: experimentKeys.detail(id),
    queryFn: () => getExperiment(id),
    enabled,
    // Evidence for a finished run never changes, so it is not worth refetching on every focus.
    staleTime: 30_000,
    /**
     * Polled only while work is actually in flight.
     *
     * The list polls itself, but this is a different query — so a run started from the full-screen
     * view used to sit there showing the previous attempt's output until something else forced a
     * refetch. Watching the run is the reason to start it from there.
     */
    refetchInterval: (query) => {
      const d = query.state.data
      return d && (d.running || d.status === 'running') ? 5000 : false
    },
  })
}
