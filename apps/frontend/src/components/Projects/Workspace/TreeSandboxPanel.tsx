import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HardDrive } from 'lucide-react'
import { getTreeWorkspace, groveKeys, releaseTreeWorkspace, type TreeWorkspaceState } from '../../../api/grove.js'

const DESCRIBED: Record<TreeWorkspaceState, string> = {
  running: 'Running — the tree\'s agents are working in it.',
  parked: 'Parked — no pod running; the tree\'s files are kept on its volume.',
  none: 'No sandbox — the next run of this tree starts a fresh one.',
}

export function TreeSandboxPanel({ treeId }: { treeId: string }) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: groveKeys.workspace(treeId),
    queryFn: () => getTreeWorkspace(treeId),
  })

  const release = useMutation({
    mutationFn: () => releaseTreeWorkspace(treeId),
    onSuccess: (next) => {
      qc.setQueryData(groveKeys.workspace(treeId), next)
      setConfirming(false)
    },
  })

  const state = data?.state

  return (
    <div className="px-3 py-2 text-[12px] text-slate-400 flex flex-col gap-2" data-testid="tree-sandbox">
      <div className="flex items-start gap-2">
        <HardDrive size={13} className="mt-0.5 shrink-0 text-slate-500" />
        <span>
          {isLoading ? 'Checking the sandbox…' : error ? 'Could not reach the cluster to check the sandbox.' : state ? DESCRIBED[state] : ''}
        </span>
      </div>
      {state && state !== 'none' && (
        confirming ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-amber-300">Delete the sandbox and every file on its volume?</span>
            <button
              type="button"
              onClick={() => release.mutate()}
              disabled={release.isPending}
              className="px-2 py-1 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-50"
            >
              {release.isPending ? 'Releasing…' : 'Delete it'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="px-2 py-1 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">
              Keep
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="self-start px-2 py-1 rounded-md border border-[var(--bark-700)] hover:bg-[var(--bark-700)] cursor-pointer"
          >
            Release sandbox
          </button>
        )
      )}
      {release.error && <span className="text-red-400">The sandbox could not be released: {(release.error as Error).message}</span>}
    </div>
  )
}
