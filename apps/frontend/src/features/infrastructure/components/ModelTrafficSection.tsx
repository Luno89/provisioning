import { useQuery } from '@tanstack/react-query'
import { getModelTraffic, MODEL_TRAFFIC_POLL_MS, modelTrafficKeys, type ModelTraffic as Traffic } from '../../models'
import { errorMessage } from '../../../api/client'
import { Section } from '../../monitoring'

const useModelTraffic = () => useQuery({ queryKey: modelTrafficKeys.all(), queryFn: getModelTraffic, refetchInterval: MODEL_TRAFFIC_POLL_MS })

const cooling = (bucket: Traffic, now: number): number | undefined => {
  const until = bucket.cooldownUntil ? Date.parse(bucket.cooldownUntil) : NaN
  return Number.isFinite(until) && until > now ? Math.ceil((until - now) / 1000) : undefined
}

export function ModelTrafficSection({ now = () => Date.now() }: { now?: () => number }) {
  const { data, isPending, isError, error } = useModelTraffic()

  return (
    <Section id="infrastructure-models" title="Model traffic">
      <p className="text-[11px] text-slate-500">Each model takes one request at a time; the rest wait in its queue, and it pauses when the server says it is busy.</p>
      {isPending && <p className="text-[12px] text-slate-500">Loading…</p>}
      {isError && <p className="text-[12px] text-red-300">{errorMessage(error)}</p>}
      {data && data.length === 0 && <p className="text-[12px] text-slate-500">No model has been called since the server started.</p>}
      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-[var(--bark-700)]">
        <table className="w-full text-[12px]">
          <thead className="bg-[var(--bark-900)] text-left text-[11px] text-slate-500">
            <tr>{['Model', 'Now', 'Waiting', 'Requests', 'Busy (429)', 'Errors', 'Last'].map((heading) => <th key={heading} className="px-3 py-2 font-medium">{heading}</th>)}</tr>
          </thead>
          <tbody className="text-slate-300">
            {data.map((bucket) => {
              const pause = cooling(bucket, now())
              return (
                <tr key={bucket.key} className="border-t border-[var(--bark-700)]">
                  <td className="max-w-[16rem] truncate px-3 py-1.5 font-semibold text-slate-100" title={bucket.label}>{bucket.label}</td>
                  <td className="px-3 py-1.5">{pause !== undefined ? `paused ${pause}s` : bucket.inFlight > 0 ? 'answering' : 'idle'}</td>
                  <td className="px-3 py-1.5">{bucket.queued}</td>
                  <td className="px-3 py-1.5">{bucket.totalRequests}</td>
                  <td className="px-3 py-1.5">{bucket.total429}</td>
                  <td className="px-3 py-1.5">{bucket.totalErrors}</td>
                  <td className="px-3 py-1.5">{bucket.lastStatus ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
    </Section>
  )
}

export default ModelTrafficSection
