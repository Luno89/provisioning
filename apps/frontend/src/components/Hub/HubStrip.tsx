import { workingOn } from '../Projects/Strip/shared'
import { projectStatus } from '../Projects/Board/board'
import { waitingLine } from '../Projects/Board/hub-waiting'
import type { HubBoardView } from '../../types/hub'
import { hubPlaceOf } from './hub-chat'

const KIND_SAID: Record<string, string> = {
  'approve-plan': 'Approving a plan',
  'reject-plan': 'Rejecting a plan',
  'order-stories': 'Reordering stories',
  'order-features': 'Reordering features',
  'accept-task': 'Accepting a task',
  'drop-task': 'Dropping a task',
  'ask-koala': 'A question for Koala',
  'open-chat': 'Opening a chat',
}

export default function HubStrip({ view, me }: { view: HubBoardView; me: string }) {
  const status = view.board.status
  const shown = status ? projectStatus(status.releases, status.runs) : undefined
  const sees = view.can.includes('see-code')
  const working = sees ? workingOn(view.board.leaves) : []
  const place = hubPlaceOf(view)
  const mine = view.requests.filter((request) => request.by.personId === me && request.state !== 'done')
  const live = status?.addresses?.live
  const preview = status?.addresses?.preview

  return (
    <div className="space-y-1 rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] px-3 py-2 text-[12px] text-slate-300" data-testid="hub-strip">
      {!view.online && <p className="text-amber-200" data-testid="hub-offline">Offline: the owner's instance is not connected. What you ask for waits and is carried out when it is back.</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {shown?.live
          ? <span>Live: {shown.live.commit.slice(0, 7)}{live && <> · <a href={live} target="_blank" rel="noreferrer" className="text-emerald-300 underline">Open the app</a></>}</span>
          : <span className="text-slate-500">Nothing is live yet.</span>}
        {shown?.preview && <span>A preview is waiting for the owner{preview && <> · <a href={preview} target="_blank" rel="noreferrer" className="text-amber-200 underline">Open the preview</a></>}</span>}
        {shown?.preparing && <span>Releasing {shown.preparing.commit.slice(0, 7)}…</span>}
        {sees && shown?.lastBuild && <span className="text-slate-400">Last build {shown.lastBuild.status} · {shown.lastBuild.commit.slice(0, 7)}</span>}
      </div>
      {sees && working.length > 0 && <p data-testid="hub-working">Being worked: {working.join(', ')}</p>}
      {mine.length > 0 && (
        <ul className="space-y-0.5 text-[11px]" data-testid="hub-my-requests">
          {mine.map((request) => (
            <li key={request.id} className={request.state === 'refused' ? 'text-rose-300' : 'text-amber-200'}>
              {KIND_SAID[request.kind] ?? request.kind}: {request.state === 'waiting'
                ? waitingLine(place, request.kind)
                : `The owner's instance did not do it: ${request.why ?? 'it gave no reason'}.`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
