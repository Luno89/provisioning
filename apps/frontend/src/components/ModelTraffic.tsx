import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import { getModelTraffic, MODEL_TRAFFIC_POLL_MS, modelTrafficKeys, type ModelTraffic as Traffic } from '../api/models'
import { errorMessage } from '../api/client'

const useModelTraffic = () => useQuery({ queryKey: modelTrafficKeys.all(), queryFn: getModelTraffic, refetchInterval: MODEL_TRAFFIC_POLL_MS })

const cooling = (bucket: Traffic, now: number): number | undefined => {
  const until = bucket.cooldownUntil ? Date.parse(bucket.cooldownUntil) : NaN
  return Number.isFinite(until) && until > now ? Math.ceil((until - now) / 1000) : undefined
}

export function ModelTraffic({ now = () => Date.now() }: { now?: () => number }) {
  const { data, isPending, isError, error } = useModelTraffic()

  return (
    <div className="rounded-xl border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-4">
      <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2"><Activity size={14} /> Model traffic</h3>
      <p className="text-[12px] text-slate-500 mt-1">Each model takes one request at a time; the rest wait in its queue, and it pauses when the server says it is busy.</p>
      {isPending && <p className="text-[12px] text-slate-500 mt-3">Loading…</p>}
      {isError && <p className="text-[12px] text-red-300 mt-3">{errorMessage(error)}</p>}
      {data && data.length === 0 && <p className="text-[12px] text-slate-500 mt-3">No model has been called since the server started.</p>}
      {data && data.length > 0 && (
        <table className="mt-3 w-full text-[12px]">
          <thead className="text-slate-500 text-left">
            <tr><th className="font-medium">Model</th><th className="font-medium">Now</th><th className="font-medium">Waiting</th><th className="font-medium">Requests</th><th className="font-medium">Busy (429)</th><th className="font-medium">Errors</th><th className="font-medium">Last</th></tr>
          </thead>
          <tbody className="text-slate-300">
            {data.map((bucket) => {
              const pause = cooling(bucket, now())
              return (
                <tr key={bucket.key}>
                  <td className="py-1 pr-2 truncate max-w-[12rem]" title={bucket.label}>{bucket.label}</td>
                  <td>{pause !== undefined ? `paused ${pause}s` : bucket.inFlight > 0 ? 'answering' : 'idle'}</td>
                  <td>{bucket.queued}</td>
                  <td>{bucket.totalRequests}</td>
                  <td>{bucket.total429}</td>
                  <td>{bucket.totalErrors}</td>
                  <td>{bucket.lastStatus ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default ModelTraffic
