import type { TreeAsk } from '../../../api/grove'
import { ApprovalBox } from '../../EngineRun/RunControls'

export default function TreeAsks({ asks }: { asks: readonly TreeAsk[] }) {
  if (asks.length === 0) return null
  return (
    <div className="space-y-2" data-testid="tree-asks">
      {asks.map((ask) => (
        <ApprovalBox key={`${ask.runId} ${ask.callId}`} runId={ask.runId} approval={{ message: ask.message, callId: ask.callId }} />
      ))}
    </div>
  )
}
