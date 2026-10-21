import { Paperclip } from 'lucide-react'
import { storedFileUrl } from '../../api/files'
import { sizeText } from '../../lib/file-drop'
import type { MessageAttachment } from '../../types/files'

export default function MessageAttachments({ attachments }: { attachments: readonly MessageAttachment[] }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="message-attachments">
      {attachments.map((attachment) => {
        const scope = attachment.project ? { kind: 'project' as const, projectId: attachment.project.id } : { kind: 'mine' as const }
        return (
          <a
            key={attachment.path}
            href={storedFileUrl(scope, attachment.path)}
            title={`${attachment.path}${attachment.project ? ` in ${attachment.project.name || 'the project'}'s files` : ' in your own files'}`}
            className="flex max-w-[280px] items-center gap-1 rounded border border-[var(--bark-700,#24332b)] bg-[var(--bark-800,#1b2620)] py-0.5 pl-2 pr-2 text-[11px] text-slate-300 hover:text-white"
          >
            <Paperclip size={10} className="shrink-0 text-emerald-400" />
            <span className="truncate">{attachment.name}</span>
            {attachment.size !== undefined && <span className="shrink-0 text-[10px] text-slate-500">{sizeText(attachment.size)}</span>}
          </a>
        )
      })}
    </div>
  )
}
