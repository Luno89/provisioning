import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { useShareProject } from './shared'

export default function NewSharedProject({ name, origin, onMade }: { name: string; origin?: { projectId: string; instanceId?: string } | undefined; onMade: (id: string) => void }) {
  const share = useShareProject()
  const asked = useRef(false)
  const { mutate } = share

  useEffect(() => {
    if (asked.current || !name) return
    asked.current = true
    mutate({ name, ...(origin ? { origin } : {}) }, { onSuccess: (view) => onMade(view.project.id) })
  }, [name, origin, mutate, onMade])

  if (!name) return <p className="p-6 text-[13px] text-red-300">Nothing was named to share.</p>
  if (share.isError) return <p className="p-6 text-[13px] text-red-300">{errorMessage(share.error)}</p>
  return <p className="p-6 text-[12px] text-slate-500"><Loader2 size={12} className="inline animate-spin" /> Sharing {name}…</p>
}
