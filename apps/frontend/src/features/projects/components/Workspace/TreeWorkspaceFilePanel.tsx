import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Boxes, CheckCircle2, Hourglass, Loader2, Plus, X } from 'lucide-react'
import { getTreeWorkspaceFile, groveKeys, saveTreeWorkspaceFile, type TreeWorkspaceView } from '../../api/grove.js'
import { errorMessage } from '../../../../api/client.js'
import Reading from '../Reading'
import NeedsPicker from '../../../../components/NeedsPicker'
import ImageContents from '../../../../components/ImageContents'
import { draftOf, fileOf, isEdited, newOnMain, type WorkspaceDraft } from './workspace-draft.js'

const UNDER_WAY_POLL_MS = 5_000

const short = (commit: string | undefined): string => (commit ? commit.slice(0, 8) : '')
const when = (at: string | undefined): string => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

function Lines({ view }: { view: TreeWorkspaceView }) {
  const lines = view.composed?.lines ?? []
  const fresh = newOnMain(lines, view.published?.lines)
  if (lines.length === 0) return <p className="text-slate-500">Nothing is installed on top of the base image.</p>
  return (
    <ul className="flex flex-col gap-0.5" data-testid="workspace-lines">
      {lines.map((line, at) => (
        <li key={`${at}-${line.from}`} className="flex items-baseline gap-2">
          <span className={`font-mono ${fresh.has(at) ? 'text-amber-200' : 'text-slate-200'}`}>{line.what}</span>
          <span className="text-[10px] text-slate-500">from {line.from}</span>
          {fresh.has(at) && <span className="text-[10px] text-amber-300/80">on main, not built yet</span>}
        </li>
      ))}
    </ul>
  )
}

function Editor({ treeId, view, onSaved }: { treeId: string; view: TreeWorkspaceView; onSaved: (next: TreeWorkspaceView & { committed: boolean }) => void }) {
  const { managers, languages } = view.can
  const [draft, setDraft] = useState<WorkspaceDraft>(() => draftOf(view.file, managers))
  const [said, setSaid] = useState('')
  const edited = isEdited(draft, view.file, managers)

  const save = useMutation({
    mutationFn: () => saveTreeWorkspaceFile(treeId, fileOf(draft), said.trim() || undefined),
    onSuccess: (next) => {
      setDraft(draftOf(next.file, managers))
      setSaid('')
      onSaved(next)
    },
  })

  const setPackages = (manager: string, text: string) => setDraft((current) => ({ ...current, packages: { ...current.packages, [manager]: text } }))
  const toggleLanguage = (language: string) => setDraft((current) => ({
    ...current,
    languages: current.languages.includes(language) ? current.languages.filter((entry) => entry !== language) : [...current.languages, language],
  }))
  const setEnv = (at: number, entry: { name: string; value: string }) => setDraft((current) => ({ ...current, env: current.env.map((own, index) => (index === at ? entry : own)) }))
  const addEnv = () => setDraft((current) => ({ ...current, env: [...current.env, { name: '', value: '' }] }))
  const dropEnv = (at: number) => setDraft((current) => ({ ...current, env: current.env.filter((_, index) => index !== at) }))

  const field = 'w-full rounded-md border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-[12px] text-slate-200 font-mono'

  return (
    <div className="flex flex-col gap-2" data-testid="workspace-editor">
      <div className="grid grid-cols-[3rem_1fr] items-center gap-x-2 gap-y-1">
        {managers.map((manager) => (
          <label key={manager} className="contents">
            <span className="text-slate-500">{manager}</span>
            <input aria-label={`${manager} packages`} value={draft.packages[manager] ?? ''} onChange={(e) => setPackages(manager, e.target.value)} placeholder="packages, by name" className={field} />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-slate-500 mr-1">languages</span>
        {languages.map((language) => (
          <button
            key={language}
            type="button"
            aria-pressed={draft.languages.includes(language)}
            onClick={() => toggleLanguage(language)}
            className={`rounded px-2 py-0.5 text-[11px] border cursor-pointer ${draft.languages.includes(language) ? 'border-[var(--leaf)] text-slate-100 bg-[var(--leaf)]/20' : 'border-[var(--bark-600)] text-slate-400 hover:bg-[var(--bark-700)]'}`}
          >
            {language}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-slate-500">environment <span className="text-[10px]">— plain values only; a secret never goes here, a model works in this workspace</span></span>
        {draft.env.map((entry, at) => (
          <div key={at} className="flex items-center gap-1">
            <input aria-label="name" value={entry.name} onChange={(e) => setEnv(at, { ...entry, name: e.target.value })} placeholder="NAME" className={`${field} w-40`} />
            <span className="text-slate-500">=</span>
            <input aria-label={`value of ${entry.name || 'it'}`} value={entry.value} onChange={(e) => setEnv(at, { ...entry, value: e.target.value })} className={field} />
            <button type="button" aria-label={`remove ${entry.name || 'this value'}`} onClick={() => dropEnv(at)} className="p-1 rounded hover:bg-[var(--bark-700)] cursor-pointer"><X size={12} /></button>
          </div>
        ))}
        <button type="button" onClick={addEnv} className="self-start flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"><Plus size={11} /> add a value</button>
      </div>

      <NeedsPicker label="workspace dependencies" value={draft.needs} onChange={(needs) => setDraft((current) => ({ ...current, needs }))} />

      <label className="flex flex-col gap-1">
        <span className="text-slate-500">install script <span className="text-[10px]">— a new one waits for you to approve it before it is built</span></span>
        <textarea aria-label="install script" value={draft.script} onChange={(e) => setDraft((current) => ({ ...current, script: e.target.value }))} rows={3} className={field} />
      </label>

      {edited && (
        <div className="flex items-center gap-2">
          <input aria-label="what changed" value={said} onChange={(e) => setSaid(e.target.value)} placeholder="what changed (the commit message)" className={`${field} font-sans`} />
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="shrink-0 px-2 py-1 rounded-md bg-[var(--leaf)]/80 hover:bg-[var(--leaf)] text-white cursor-pointer disabled:opacity-50"
          >
            {save.isPending ? 'Committing…' : 'Commit to main'}
          </button>
          <button type="button" onClick={() => setDraft(draftOf(view.file, managers))} className="shrink-0 px-2 py-1 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">Undo</button>
        </div>
      )}
      {save.error && <span className="text-red-400">{errorMessage(save.error)}</span>}
    </div>
  )
}

export function TreeWorkspaceFilePanel({ treeId }: { treeId: string }) {
  const qc = useQueryClient()
  const [savedNote, setSavedNote] = useState<string | undefined>()
  const { data: view, error } = useQuery({
    queryKey: groveKeys.workspaceFile(treeId),
    queryFn: () => getTreeWorkspaceFile(treeId),
    refetchInterval: (query) => (query.state.data?.next?.stage === 'building' || query.state.data?.next?.stage === 'waiting' ? UNDER_WAY_POLL_MS : false),
  })

  if (!view) return error ? <p className="px-3 py-2 text-[12px] text-red-400">Could not read the tree's workspace: {errorMessage(error)}</p> : <Reading label="Reading the tree's workspace…" className="px-3 py-2" />

  const onSaved = (next: TreeWorkspaceView & { committed: boolean }) => {
    qc.setQueryData(groveKeys.workspaceFile(treeId), next)
    setSavedNote(next.committed ? 'Committed to main. The workspace is being rebuilt; runs keep the one they have until it is ready.' : 'Nothing changed, so nothing was committed.')
  }

  return (
    <div className="px-3 py-2 text-[12px] text-slate-400 flex flex-col gap-3" data-testid="tree-workspace-file">
      <p className="flex items-start gap-2">
        <Boxes size={13} className="mt-0.5 shrink-0 text-slate-500" />
        <span>
          What the tree's agents work in: its type's base, <span className="font-mono">{view.path}</span> on main and the tools of every agent that works in it.
          {view.published
            ? <> They work in the image built {view.published.commit ? <>from <span className="font-mono">{short(view.published.commit)}</span> </> : ''}on {when(view.published.publishedAt)}.</>
            : ' It has not been built yet; the first run builds it.'}
        </span>
      </p>

      {view.next && (
        <p className="flex items-start gap-2" data-testid="workspace-next">
          {view.next.stage === 'building' ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-amber-300" />
            : view.next.stage === 'waiting' ? <Hourglass size={13} className="mt-0.5 shrink-0 text-amber-300" />
              : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-red-300" />}
          <span className={view.next.stage === 'failed' || view.next.stage === 'declined' ? 'text-red-300' : 'text-amber-200'}>
            The next workspace{view.next.commit ? <> (from <span className="font-mono">{short(view.next.commit)}</span>)</> : ''} is {view.next.text}.
          </span>
        </p>
      )}
      {!view.next && view.pending.length > 0 && view.published && (
        <p className="text-amber-200">Main asks for {view.pending.join('; ')}, which the workspace does not have yet.</p>
      )}

      {view.unreadable && <p className="text-red-300">{view.unreadable}</p>}
      {view.unbuildable && <p className="text-red-300">It cannot be built: {view.unbuildable}</p>}
      {view.composed && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">What it has, and why</span>
          <ImageContents contents={view.composed.contents ?? []} empty="No workspace dependency: nothing in this tree or its project needs one." />
        </div>
      )}
      {view.composed && <Lines view={view} />}

      {view.file && <Editor key={JSON.stringify(view.file)} treeId={treeId} view={view} onSaved={onSaved} />}
      {savedNote && <p className="text-emerald-300/90">{savedNote}</p>}

      {view.builds.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="workspace-builds">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Builds</span>
          {view.builds.map((build) => (
            <div key={build.runId} className="flex items-start gap-2">
              {build.outcome === 'ok' ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-300" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0 text-red-300" />}
              <span className="font-mono text-slate-300">{short(build.runId.slice(-12))}</span>
              <span>{when(build.finishedAt)}</span>
              <span className="text-slate-500">{Math.round(build.wallClockMs / 1000)}s</span>
              {build.reason && <span className="text-red-300/90">{build.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
