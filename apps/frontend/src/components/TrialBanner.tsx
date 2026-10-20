import { Clock } from 'lucide-react'
import { useInstanceTrial } from '../api/instances'

const KEEP_DAYS = 30
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

export default function TrialBanner() {
  const trial = useInstanceTrial()
  const ends = trial.data?.trialEndsAt ? Date.parse(trial.data.trialEndsAt) : undefined
  if (!ends) return null
  const left = trial.data?.daysLeft ?? 0
  return (
    <div role="status" className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100">
      <Clock size={13} className="shrink-0" />
      <span>
        This instance runs on Koala's servers for a trial that ends on {day(ends)}{left > 0 ? `, in ${left} day${left === 1 ? '' : 's'}` : ''}.
        Then it stops, and its work is kept until {day(ends + KEEP_DAYS * 86_400_000)}.
      </span>
      <a href="#/settings" className="ml-auto shrink-0 font-semibold underline hover:text-white">Move it to your own machine</a>
    </div>
  )
}
