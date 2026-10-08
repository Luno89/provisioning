import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { artifactKeys, getArtifactStorage } from '../api/artifacts'
import { dismissPrompt, promptDismissed } from '../lib/artifact-storage'
import { useShellStore } from '../stores/shell'

export default function ArtifactStoragePrompt() {
  const [dismissed, setDismissed] = useState(promptDismissed)
  const openAppDeploy = useShellStore((s) => s.openAppDeploy)
  const storage = useQuery({ queryKey: artifactKeys.storage, queryFn: getArtifactStorage, staleTime: 60_000 })

  if (dismissed || !storage.data || storage.data.minio) return null

  const dismiss = () => {
    dismissPrompt()
    setDismissed(true)
  }

  return (
    <div role="note" className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-[12px] text-slate-300">
      <span className="flex-1 min-w-[14rem]">
        Browser test screenshots, traces and videos are kept in Koala's database for 14 days. Deploy MinIO on your
        cluster and new ones are kept there instead.
      </span>
      <button type="button" onClick={() => openAppDeploy({ appType: 'minio', name: 'minio' })}
        className="rounded-lg bg-sky-500/80 px-3 py-1.5 font-bold text-white hover:bg-sky-500">
        Deploy MinIO
      </button>
      <button type="button" onClick={dismiss} className="text-slate-400 hover:text-slate-200">
        Not now
      </button>
    </div>
  )
}
