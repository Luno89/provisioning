import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, ExternalLink, FileCode2, Layers, Loader2, Repeat, Trash2, Undo2 } from 'lucide-react'
import { AGAIN_FROM, decideRelease, listReleases, releaseAgain, releaseKeys, rollBackRelease, type OdooRelease, type ReleaseState, type RollBackOffer } from '../../../api/releases'
import { ago } from '../../../features/projects'
import { errorMessage } from '../../../api/client'
import { ReleaseBrowserTests } from './ReleaseBrowserTests'
import { ReleaseChanges } from './ReleaseChanges'
import { ReleaseFiles } from './ReleaseFiles'
import { releaseKind, type ReleaseKind } from './release-kind'
import { OpenApp } from './OpenApp'

const STATE: Record<ReleaseState, { label: string; tone: string }> = {
  queued: { label: 'waiting its turn', tone: 'text-slate-300 bg-slate-500/10 border-slate-600/40' },
  preparing: { label: 'preparing', tone: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  preview: { label: 'ready to preview', tone: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  'cutting-over': { label: 'cutting over', tone: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  live: { label: 'live', tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  'rolling-back': { label: 'rolling back', tone: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  'rolled-back': { label: 'rolled back', tone: 'text-slate-400 bg-slate-500/10 border-slate-600/40' },
  discarded: { label: 'discarded', tone: 'text-slate-400 bg-slate-500/10 border-slate-600/40' },
  superseded: { label: 'replaced', tone: 'text-slate-400 bg-slate-500/10 border-slate-600/40' },
  failed: { label: 'failed', tone: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function Decision({ projectId, release, preview }: { projectId: string; release: OdooRelease; preview?: string | undefined }) {
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const losing = release.changes?.losing === true
  const decide = useMutation({
    mutationFn: (decision: 'cut-over' | 'discard') => decideRelease(projectId, release.id, decision, decision === 'cut-over' && losing),
    onSuccess: () => { setConfirming(false); void client.invalidateQueries({ queryKey: releaseKeys.list(projectId) }) },
  })

  return (
    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
      <p className="text-[11px] text-slate-300">
        This build is running in slot {release.slot?.toUpperCase()} on a copy of the live data. Look it over, then make it live.
      </p>
      <ReleaseChanges changes={release.changes} />
      <ReleaseFiles projectId={projectId} releaseId={release.id} />
      <div className="flex flex-wrap items-center gap-2">
        {preview
          ? <a href={preview} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded border border-amber-500/40 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/10"><ExternalLink size={11} /> Open preview</a>
          : <OpenApp projectId={projectId} which="preview" />}
        {!confirming ? (
          <>
            <button type="button" onClick={() => setConfirming(true)} disabled={decide.isPending} className="flex items-center gap-1 rounded bg-emerald-600/80 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              <ArrowRightLeft size={11} /> {losing ? 'Cut over, losing these' : 'Cut over'}
            </button>
            <button type="button" onClick={() => decide.mutate('discard')} disabled={decide.isPending} className="flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700 disabled:opacity-50">
              <Trash2 size={11} /> Discard
            </button>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-300">
              {losing ? `Cutting over loses for good: ${release.changes!.lost.join('; ')}. ` : ''}The app is down while the latest data is copied over and upgraded — usually under a minute. Cut over now?
            </span>
            <button type="button" onClick={() => decide.mutate('cut-over')} disabled={decide.isPending} className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 ${losing ? 'bg-rose-600' : 'bg-emerald-600'}`}>
              {decide.isPending ? <Loader2 size={11} className="animate-spin" /> : <ArrowRightLeft size={11} />} {losing ? 'Yes, cut over and lose them' : 'Yes, cut over'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300">Not yet</button>
          </div>
        )}
      </div>
      {decide.isError && <p className="text-[11px] text-rose-400">{errorMessage(decide.error)}</p>}
    </div>
  )
}

function RollBack({ projectId, offer }: { projectId: string; offer: RollBackOffer }) {
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const back = useMutation({
    mutationFn: () => rollBackRelease(projectId, offer.from),
    onSuccess: () => { setConfirming(false); void client.invalidateQueries({ queryKey: releaseKeys.list(projectId) }) },
  })
  const since = offer.liveSince ? ` ${ago(offer.liveSince)}` : ''

  return (
    <div className="space-y-1.5">
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700">
          <Undo2 size={11} /> Roll back to {offer.commit.slice(0, 8)}
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5">
          <p className="text-[11px] text-slate-300">
            This goes back to {offer.commit.slice(0, 8)} exactly as it was at the cutover{since}. Anything entered in the app since then is lost. Roll back now?
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => back.mutate()} disabled={back.isPending} className="flex items-center gap-1 rounded bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">
              {back.isPending ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} Yes, roll back
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300">Keep this one</button>
          </div>
        </div>
      )}
      {back.isError && <p className="text-[11px] text-rose-400">{errorMessage(back.error)}</p>}
    </div>
  )
}

function KindBadge({ kind }: { kind: ReleaseKind }) {
  if (kind.kind === 'new-code') {
    return <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300" title="Built from new code: a new image is deployed">new code</span>
  }
  const of = kind.kind === 'again' ? kind.of : kind.as
  return (
    <span className="rounded border border-slate-600/40 bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-400" title="No new code: the same image as an earlier release, prepared again on a fresh copy of the live data">
      {kind.kind === 'again' ? 'released again' : 'same image'}{of ? ` · ${of.slice(0, 8)}` : ''}
    </span>
  )
}

function ReleaseAgain({ projectId, release, previewWaits }: { projectId: string; release: OdooRelease; previewWaits: boolean }) {
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const again = useMutation({
    mutationFn: () => releaseAgain(projectId, release.id),
    onSuccess: () => { setConfirming(false); void client.invalidateQueries({ queryKey: releaseKeys.list(projectId) }) },
  })

  return (
    <div className="space-y-1.5">
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700">
          <Repeat size={11} /> Release this build again
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-slate-600 bg-slate-500/5 p-2.5">
          <p className="text-[11px] text-slate-300">
            No code changes: the image of {release.commit.slice(0, 8)} is prepared again in the idle slot, from a fresh copy of the live data, and tested.{previewWaits ? ' The preview waiting now is set aside.' : ''} Nothing goes live until you cut it over.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => again.mutate()} disabled={again.isPending} className="flex items-center gap-1 rounded bg-sky-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">
              {again.isPending ? <Loader2 size={11} className="animate-spin" /> : <Repeat size={11} />} Yes, release it again
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300">Not now</button>
          </div>
        </div>
      )}
      {again.isError && <p className="text-[11px] text-rose-400">{errorMessage(again.error)}</p>}
    </div>
  )
}

function FilesToggle({ projectId, releaseId }: { projectId: string; releaseId: string }) {
  const [open, setOpen] = useState(false)
  if (open) return <ReleaseFiles projectId={projectId} releaseId={releaseId} />
  return (
    <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200">
      <FileCode2 size={11} /> Files changed
    </button>
  )
}

export function ReleasesPanel({ projectId }: { projectId: string }) {
  const { data } = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId) })
  const releases = data?.releases ?? []
  if (releases.length === 0) return null

  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
        <Layers size={11} /> Releases
        {data?.addresses.live && <a href={data.addresses.live} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 normal-case tracking-normal text-emerald-300 hover:underline"><ExternalLink size={10} /> Open live</a>}
      </h4>
      <ul className="space-y-2">
        {releases.map((release) => (
          <li key={release.id} className="space-y-1.5 rounded-md border border-[var(--bark-800)] p-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className={`rounded border px-1.5 py-0.5 text-[10px] ${STATE[release.state].tone}`}>{STATE[release.state].label}</span>
              <KindBadge kind={releaseKind(release, releases)} />
              <span className="text-slate-300">{release.commit.slice(0, 8)}</span>
              {release.slot && <span className="text-slate-500">slot {release.slot.toUpperCase()}</span>}
              <span className="ml-auto text-slate-500">{when(release.startedAt)}</span>
            </div>
            {release.reason && <p className={`text-[11px] ${release.state === 'failed' ? 'text-rose-300' : 'text-slate-500'}`}>{release.reason}</p>}
            {release.state === 'preview' && <Decision projectId={projectId} release={release} preview={data?.addresses.preview} />}
            {data?.rollBack?.from === release.id && <RollBack projectId={projectId} offer={data.rollBack} />}
            {(release.state === 'preview' || release.state === 'live') && <ReleaseBrowserTests projectId={projectId} release={release} />}
            {release.state !== 'preview' && <FilesToggle projectId={projectId} releaseId={release.id} />}
            {AGAIN_FROM.includes(release.state) && <ReleaseAgain projectId={projectId} release={release} previewWaits={releases.some((other) => other.state === 'preview')} />}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default ReleasesPanel
