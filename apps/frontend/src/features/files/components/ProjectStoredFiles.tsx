import { useState } from 'react'
import { Clock } from 'lucide-react'
import type { PickedFile } from '../lib/file-drop'
import DropTarget from './DropTarget'
import FilePlacePicker from './FilePlacePicker'
import StoredFiles from './StoredFiles'
import { useFilePlace, useSharedWithHub } from '../shared'

export default function ProjectStoredFiles({ projectId, dir = '', title = 'Files', onOpen }: { projectId: string; dir?: string | undefined; title?: string | undefined; onOpen?: ((path: string) => void) | undefined }) {
  const place = useFilePlace(projectId)
  const scope = { kind: 'project' as const, projectId }
  const [held, setHeld] = useState<{ dir: string; picked: PickedFile[] } | undefined>()
  const ready = place.data?.state === 'ready'
  const shared = useSharedWithHub(projectId)

  if (ready) return <StoredFiles scope={scope} dir={dir} title={title} waiting={held} onTaken={() => setHeld(undefined)} onOpen={onOpen} clients={shared ? 'share' : undefined} />

  return (
    <DropTarget
      label={`Drop to add to ${title} once it has a file server`}
      onFiles={(picked) => setHeld({ dir, picked: [...(held?.picked ?? []), ...picked] })}
      className="min-h-[60px]"
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</div>
      <FilePlacePicker projectId={projectId} compact />
      {held && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-200" data-testid="held-files">
          <Clock size={11} /> {held.picked.length} file{held.picked.length === 1 ? '' : 's'} waiting: {place.data?.state === 'starting' ? 'they are added as soon as the file server is running' : 'choose a file server or start MinIO above, and they are added once it runs'}.
        </p>
      )}
    </DropTarget>
  )
}
