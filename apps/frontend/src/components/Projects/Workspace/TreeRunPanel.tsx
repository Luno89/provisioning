import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Play, Square } from 'lucide-react'
import { getTreeRun, groveKeys, runTree, stopTreeRun, type TreeRunStatus } from '../../../api/grove.js'
import { errorMessage } from '../../../api/client.js'

const RUNNING_POLL_MS = 5_000

function describe(status: TreeRunStatus): string {
  switch (status.state) {
    case 'none': return 'Not run yet — the leaves wait until you run the tree.'
    case 'unavailable': return 'Temporal is not reachable, so the tree cannot run right now.'
    case 'running': return `Running since ${new Date(status.startedAt).toLocaleTimeString()} — leaves are worked and judged pass by pass.`
    case 'failed': return `The last run stopped: ${status.reason}.`
    case 'finished': {
      const { outcome, passes, awaitingReview, awaitingApproval = [] } = status.result
      const review = [
        awaitingReview.length > 0 ? ` ${awaitingReview.length} claim${awaitingReview.length === 1 ? ' waits' : 's wait'} for your review.` : '',
        awaitingApproval.length > 0 ? ` ${awaitingApproval.length} leaf plan${awaitingApproval.length === 1 ? ' waits' : 's wait'} for your approval above.` : '',
      ].join('')
      if (outcome === 'stopped') return `You stopped the last run after ${passes} pass${passes === 1 ? '' : 'es'}; the leaves it was working are back to waiting.${review}`
      return outcome === 'capped'
        ? `The last run stopped at its pass limit after ${passes} passes — something kept coming back.${review}`
        : `The last run finished after ${passes} pass${passes === 1 ? '' : 'es'}: nothing left to work.${review}`
    }
  }
}

export function TreeRunPanel({ treeId }: { treeId: string }) {
  const qc = useQueryClient()
  const { data: status, error } = useQuery({
    queryKey: groveKeys.run(treeId),
    queryFn: () => getTreeRun(treeId),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? RUNNING_POLL_MS : false),
  })

  const running = status?.state === 'running'
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: groveKeys.leaves() })
    wasRunning.current = running
  }, [running, qc])

  const run = useMutation({
    mutationFn: () => runTree(treeId),
    onSuccess: (next) => {
      stop.reset()
      qc.setQueryData(groveKeys.run(treeId), { ...next, engine: true })
      void qc.invalidateQueries({ queryKey: groveKeys.leaves() })
    },
  })

  const stop = useMutation({
    mutationFn: () => stopTreeRun(treeId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: groveKeys.run(treeId) }),
  })

  if (!status?.engine) return null

  return (
    <div className="px-3 py-2 text-[12px] text-slate-400 flex flex-col gap-2" data-testid="tree-run">
      <div className="flex items-start gap-2">
        {running && <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-emerald-400" />}
        <span>{error ? 'Could not read the tree\'s run.' : describe(status)}</span>
      </div>
      {!running && (
        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={run.isPending || status.state === 'unavailable'}
          className="self-start px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
        >
          {run.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          {status.state === 'none' ? 'Run the tree' : 'Run it again'}
        </button>
      )}
      {running && (
        <button
          type="button"
          onClick={() => stop.mutate()}
          disabled={stop.isPending || stop.isSuccess}
          className="self-start px-2.5 py-1 rounded border border-[var(--bark-600)] hover:bg-[var(--bark-700)] text-slate-200 cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
        >
          {stop.isPending || stop.isSuccess ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
          {stop.isPending || stop.isSuccess ? 'Stopping…' : 'Stop the run'}
        </button>
      )}
      {run.error && <span className="text-red-400">{errorMessage(run.error) || 'The tree did not start.'}</span>}
      {stop.error && <span className="text-red-400">{errorMessage(stop.error) || 'The run could not be stopped.'}</span>}
    </div>
  )
}
