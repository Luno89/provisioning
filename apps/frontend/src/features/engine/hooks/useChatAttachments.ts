import { useCallback, useState } from 'react'
import { errorMessage } from '../../../api/client'
import { uploadStoredFile } from '../../files'
import { attachmentPlace, type PickedFile } from '../../files'
import type { MessageAttachment } from '../../files'

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

export function useChatAttachments(project: { id: string; name: string } | undefined, conversation: () => Promise<string>) {
  const [attached, setAttached] = useState<ChatAttachment[]>([])
  const change = (key: string, patch: Partial<ChatAttachment>) => setAttached((all) => all.map((one) => (one.key === key ? { ...one, ...patch } : one)))

  const attach = useCallback((picked: PickedFile[]) => {
    for (const one of picked) {
      counter += 1
      const key = `${Date.now()}-${counter}`
      setAttached((all) => [...all, { key, name: one.file.name, size: one.file.size, state: 'uploading', share: 0 }])
      conversation()
        .then((conversationId) => {
          const place = attachmentPlace(conversationId, project?.id, one.file.name)
          return uploadStoredFile(place.scope, place.path, one.file, (share) => change(key, { share }))
        })
        .then(({ id }) => change(key, {
          state: 'ready',
          share: 1,
          stored: { fileId: id, name: one.file.name, size: one.file.size, ...(one.file.type ? { type: one.file.type } : {}), ...(project ? { project } : {}) },
        }))
        .catch((err: unknown) => change(key, { state: 'failed', why: errorMessage(err) }))
    }
  }, [project, conversation])

  const remove = useCallback((key: string) => setAttached((all) => all.filter((one) => one.key !== key)), [])
  const ready = attached.flatMap((one) => (one.state === 'ready' && one.stored ? [one.stored] : []))
  const uploading = attached.some((one) => one.state === 'uploading')
  const clear = useCallback(() => setAttached([]), [])

  return { attached, attach, remove, ready, uploading, clear }
}
