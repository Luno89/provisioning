import { useCallback, useState } from 'react'
import { errorMessage } from '../../../api/client'
import { uploadStoredFile } from '../../../api/files'
import { attachmentPath, type PickedFile } from '../../../lib/file-drop'
import type { MessageAttachment } from '../../../types/files'

export interface ChatAttachment {
  key: string
  name: string
  size: number
  state: 'uploading' | 'ready' | 'failed'
  share: number
  why?: string | undefined
  stored?: MessageAttachment | undefined
}

let counter = 0

export function useChatAttachments(project: { id: string; name: string } | undefined) {
  const [attached, setAttached] = useState<ChatAttachment[]>([])
  const change = (key: string, patch: Partial<ChatAttachment>) => setAttached((all) => all.map((one) => (one.key === key ? { ...one, ...patch } : one)))

  const attach = useCallback((picked: PickedFile[]) => {
    for (const one of picked) {
      counter += 1
      const key = `${Date.now()}-${counter}`
      const path = attachmentPath(Boolean(project), one.file.name, new Date())
      setAttached((all) => [...all, { key, name: one.file.name, size: one.file.size, state: 'uploading', share: 0 }])
      const scope = project ? { kind: 'project' as const, projectId: project.id } : { kind: 'mine' as const }
      uploadStoredFile(scope, path, one.file, (share) => change(key, { share }))
        .then(() => change(key, {
          state: 'ready',
          share: 1,
          stored: { name: one.file.name, path, size: one.file.size, ...(one.file.type ? { type: one.file.type } : {}), ...(project ? { project } : {}) },
        }))
        .catch((err: unknown) => change(key, { state: 'failed', why: errorMessage(err) }))
    }
  }, [project])

  const remove = useCallback((key: string) => setAttached((all) => all.filter((one) => one.key !== key)), [])
  const ready = attached.flatMap((one) => (one.state === 'ready' && one.stored ? [one.stored] : []))
  const uploading = attached.some((one) => one.state === 'uploading')
  const clear = useCallback(() => setAttached([]), [])

  return { attached, attach, remove, ready, uploading, clear }
}
