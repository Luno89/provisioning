import { Loader2 } from 'lucide-react'
import { EFFORT_MEASURES, HEADROOM, SUCCESSES_BEFORE_LIMITS, TYPICAL_PERCENTILE } from '@koala/agent-engine/procedure'
import { describeEffort } from '../../lib/procedure-drafts'
import { errorMessage, useTrackRecords } from './shared'

export default function TrackRecords({ procedureId }: { procedureId: string }) {
  const records = useTrackRecords(procedureId)
  const headroom = Math.round((HEADROOM - 1) * 100)
  const typical = Math.round(TYPICAL_PERCENTILE * 100)

  return (
    <div className="space-y-2">
      <p className="text-[10px] leading-snug text-slate-500">
        Runs are not held to a fixed limit, and neither is the size of a reply. Once a model has finished this procedure {SUCCESSES_BEFORE_LIMITS} times, a run gets {headroom}% more than what {typical}% of those runs needed. Until then a reply may use whatever the context window has room for, and only the loop and stall checks stop it.
      </p>
      {records.isPending && <p className="flex items-center gap-1 text-[11px] text-slate-500"><Loader2 size={11} className="animate-spin" /> Loading track records…</p>}
      {records.isError && <p className="text-[11px] text-red-300">{errorMessage(records.error)}</p>}
      {records.data?.length === 0 && <p className="text-[11px] text-slate-500">No runs yet.</p>}
      {records.data?.map((record) => (
        <div key={record.modelKey} className="rounded-md border border-[var(--bark-700)] p-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-200">{record.modelLabel}</span>
            <span className="ml-auto text-slate-500">{record.successes} of {record.runs} succeeded</span>
          </div>
          {record.successes > 0 && (
            <table className="mt-1.5 w-full text-left">
              <thead>
                <tr className="text-[10px] text-slate-500">
                  <th className="font-normal">Usually needs</th>
                  <th className="font-normal">Limit</th>
                </tr>
              </thead>
              <tbody>
                {EFFORT_MEASURES.filter(({ measure }) => record.typical[measure] > 0).map(({ measure, limit }) => (
                  <tr key={measure} className="text-slate-300">
                    <td>{describeEffort(measure, record.typical[measure])}</td>
                    <td className="text-slate-400">{record.limits?.[limit] !== undefined ? describeEffort(measure, record.limits[limit]!) : 'none yet'}</td>
                  </tr>
                ))}
                {(record.largestReply > 0 || record.cappedAt > 0) && (
                  <tr className="text-slate-300">
                    <td>
                      {record.largestReply} tokens in its longest reply
                      {record.cappedAt > 0 ? `, and one was cut off at ${record.cappedAt}` : ''}
                    </td>
                    <td className="text-slate-400">{record.replyCeiling === undefined ? 'whatever the window allows' : `${record.replyCeiling} tokens`}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {!record.limits && (
            <p className="mt-1 text-[10px] text-slate-500">
              {SUCCESSES_BEFORE_LIMITS - record.successes} more successful {SUCCESSES_BEFORE_LIMITS - record.successes === 1 ? 'run' : 'runs'} before limits apply.
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
