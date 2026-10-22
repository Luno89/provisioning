import { ShieldAlert } from 'lucide-react'
import type { ApprovalDecision } from '../../hooks/useConversationTurn'

export interface ChatApprovalCardProps {
  reason: string
  toolName?: string | undefined
  args?: string | undefined
  onDecide: (decision: ApprovalDecision | 'auto-chat') => void
}

const quiet = 'px-2.5 py-1 rounded bg-red-900/40 hover:bg-red-800/60 text-red-100 border border-red-500/30 transition-colors cursor-pointer text-xs'

export default function ChatApprovalCard({ reason, toolName, args, onDecide }: ChatApprovalCardProps) {
  return (
    <div className="w-full p-3 my-2 rounded-md bg-red-950/60 border border-red-500/50 text-red-100 font-sans text-xs space-y-2">
      <div className="flex items-start gap-2 min-w-0">
        <ShieldAlert size={14} className="text-red-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <span className="text-red-100 break-words">{reason}</span>
          {args ? <span className="block text-red-300/80 mt-1 break-words">{toolName ?? 'a tool'} {args}</span> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onDecide('allow')}
          className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer text-xs font-medium"
        >
          Allow
        </button>
        <button type="button" onClick={() => onDecide('allow-for-run')} title="Nothing else this run does asks again" className={quiet}>
          Allow for this run
        </button>
        {toolName ? (
          <button type="button" onClick={() => onDecide('allow-in-chat')} title={`${toolName} will not ask again in this conversation`} className={quiet}>
            Allow {toolName} in this chat
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onDecide('auto-chat')}
          title="Turns on auto mode for this chat and lets this through: nothing it runs asks again, any command or tool, including the agents it hands work to, until you switch it off beside the model"
          className={quiet}
        >
          Auto mode for this chat
        </button>
        <button
          type="button"
          onClick={() => onDecide('decline')}
          className="ml-auto px-2.5 py-1 rounded bg-red-900/70 hover:bg-red-800/70 text-red-100 transition-colors cursor-pointer text-xs font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  )
}
