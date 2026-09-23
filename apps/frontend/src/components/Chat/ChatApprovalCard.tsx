import { ShieldAlert } from 'lucide-react'

export interface ChatApprovalCardProps {
  /** The engine's warn notice: what is being asked of the person. */
  reason: string
  toolName?: string | undefined
  args?: string | undefined
  onAllow: () => void
  onDeny: () => void
}

// The engine paused the run because a tool call needs the person's say-so. Deciding either way
// sends the run back into motion.
export default function ChatApprovalCard({ reason, toolName, args, onAllow, onDeny }: ChatApprovalCardProps) {
  return (
    <div className="w-full p-3 my-2 rounded-md bg-red-950/60 border border-red-500/50 text-red-100 font-sans text-xs flex items-center justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <ShieldAlert size={14} className="text-red-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <span className="text-red-100">{reason}</span>
          {(toolName || args) ? (
            <span className="block text-red-300/80 mt-1 break-words">
              {toolName ?? 'a tool'}{args ? ` ${args}` : ''}
            </span>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDeny}
          className="px-2.5 py-1 rounded bg-red-900/70 hover:bg-red-800/70 text-red-100 transition-colors cursor-pointer text-xs font-medium"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={onAllow}
          className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer text-xs font-medium"
        >
          Allow
        </button>
      </div>
    </div>
  )
}