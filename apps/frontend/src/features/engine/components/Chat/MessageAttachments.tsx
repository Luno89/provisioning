import { Paperclip } from 'lucide-react'
import { sentAttachmentPlace, storedFileUrl } from '../../../files'
import { sizeText } from '../../../files'
import type { MessageAttachment } from '../../../files'

const chip = 'flex max-w-[280px] items-center gap-1 rounded border border-[var(--bark-700,#24332b)] bg-[var(--bark-800,#1b2620)] py-0.5 pl-2 pr-2 text-[11px]'

export default function MessageAttachments({ attachments, conversationId }: { attachments: readonly MessageAttachment[]; conversationId?: string | undefined }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="message-attachments">
      {attachments.map((attachment, index) => {
        const place = sentAttachmentPlace(attachment, conversationId)
        const size = attachment.size !== undefined && <span className="shrink-0 text-[10px] text-slate-500">{sizeText(attachment.size)}</span>
        if (!place) {
          const why = attachment.fileId ? 'cannot be opened here' : 'no longer available'
          return (
            <span key={`${attachment.name}-${index}`} title={`${attachment.name}: ${why}`} className={`${chip} text-slate-500`}>
              <Paperclip size={10} className="shrink-0 text-slate-600" />
              <span className="truncate">{attachment.name}</span>
              <span className="shrink-0 text-[10px]">{why}</span>
            </span>
          )
        }
        return (
          <a
            key={attachment.fileId ?? `${attachment.name}-${index}`}
            href={storedFileUrl(place.scope, place.path)}
            title={`${place.path}${attachment.project ? ` in ${attachment.project.name || 'the project'}'s files` : ' in this chat\'s files'}`}
            className={`${chip} text-slate-300 hover:text-white`}
          >
            <Paperclip size={10} className="shrink-0 text-emerald-400" />
            <span className="truncate">{attachment.name}</span>
            {size}
          </a>
        )
      })}
    </div>
  )
}
