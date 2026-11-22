import type { PersonRemoval } from '../types'
import { koalaAwayText, koalaProblemText } from '../shared'
import { deletionLines } from '../../projects'

export function RemovalLines({ removal }: { removal: PersonRemoval }) {
  return (
    <>
      {removal.koalaAway && <div className="text-xs text-amber-300 mt-0.5">{koalaAwayText(removal.koalaAway)}</div>}
      {removal.machinesAway?.map((away) => <div key={away.machine} className="text-xs text-amber-300 mt-0.5">{koalaAwayText(away)}</div>)}
      {removal.koala?.problem && <div className="text-xs text-red-300 mt-0.5">{koalaProblemText(removal.koala.problem)}</div>}
      {removal.koala && (
        <ul className="text-xs text-slate-400 mt-1 space-y-0.5">
          {deletionLines(removal.koala).map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </>
  )
}
