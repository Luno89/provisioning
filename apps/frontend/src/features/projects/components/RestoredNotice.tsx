import { useDeletionsStore } from '../stores/deletions'

export function RestoredNotice({ projectId }: { projectId: string }) {
  const restored = useDeletionsStore((state) => state.restored[projectId])
  const dismiss = useDeletionsStore((state) => state.dismissRestored)
  if (!restored) return null
  return (
    <div role="status" className="mb-3 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-[12px] text-slate-300 space-y-1">
      <p className="text-emerald-300">Restored, with its code, trees, chats, runs and files.</p>
      {restored.renamed && <p>A project of its name exists now, so it is back as “{restored.name}”.</p>}
      <p>Its apps and secrets were deleted; deploy again to run it.</p>
      {restored.secrets.length > 0 && <p>Enter its secrets again: {restored.secrets.join(', ')}</p>}
      <button type="button" onClick={() => dismiss(projectId)} className="px-2 py-1 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">Dismiss</button>
    </div>
  )
}

export default RestoredNotice
