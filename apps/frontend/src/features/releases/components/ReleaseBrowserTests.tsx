import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleSlash, Loader2, MonitorPlay, RotateCw, XCircle } from 'lucide-react'
import { releaseKeys, retestRelease, type OdooRelease, type ReleaseE2E } from '../api/releases'
import { errorMessage } from '../../../api/client'
import { artifactUrl } from '../../files'
import { ArtifactStoragePrompt } from '../../files'

const HEADLINE: Record<ReleaseE2E['state'], { text: string; tone: string }> = {
  running: { text: 'Browser tests running against the preview…', tone: 'text-sky-300' },
  passed: { text: 'Browser tests passed', tone: 'text-emerald-300' },
  failed: { text: 'Browser tests failed', tone: 'text-rose-300' },
  unavailable: { text: 'Browser tests could not run', tone: 'text-slate-400' },
  stopped: { text: 'Browser tests stopped', tone: 'text-slate-400' },
}

const Icon = ({ state }: { state: ReleaseE2E['state'] }) => {
  if (state === 'running') return <Loader2 size={11} className="animate-spin" />
  if (state === 'passed') return <CheckCircle2 size={11} />
  if (state === 'failed') return <XCircle size={11} />
  return <CircleSlash size={11} />
}

const isImage = (name: string) => /\.(png|jpe?g)$/i.test(name)

export function ReleaseBrowserTests({ projectId, release }: { projectId: string; release: OdooRelease }) {
  const client = useQueryClient()
  const again = useMutation({
    mutationFn: () => retestRelease(projectId, release.id),
    onSuccess: () => { void client.invalidateQueries({ queryKey: releaseKeys.list(projectId) }) },
  })
  const e2e = release.e2e
  if (!e2e) return null
  const headline = HEADLINE[e2e.state]
  const failed = (e2e.tests ?? []).filter((test) => test.status === 'failed')
  const others = (e2e.tests ?? []).filter((test) => test.status !== 'failed')
  const artifacts = e2e.artifacts ?? []

  return (
    <div className="space-y-1.5 rounded-md border border-[var(--bark-800)] bg-slate-900/40 p-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <MonitorPlay size={11} className="text-slate-500" />
        <span className={`flex items-center gap-1 font-semibold ${headline.tone}`}><Icon state={e2e.state} /> {headline.text}</span>
        {e2e.summary && <span className="text-slate-400">{e2e.summary}</span>}
        {release.state === 'preview' && e2e.state !== 'running' && (
          <button type="button" onClick={() => again.mutate()} disabled={again.isPending} className="ml-auto flex items-center gap-1 rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 disabled:opacity-50">
            <RotateCw size={10} /> Run again
          </button>
        )}
      </div>
      {e2e.state !== 'running' && release.state === 'preview' && (
        <p className="text-[10px] text-slate-500">Advice only: you can cut over whatever the tests say.</p>
      )}
      {e2e.reason && <pre className="whitespace-pre-wrap break-words text-[10px] text-slate-400">{e2e.reason}</pre>}
      {failed.length > 0 && (
        <ul className="space-y-1">
          {failed.map((test) => (
            <li key={`${test.file}:${test.title}`} className="text-[11px]">
              <span className="text-rose-300">✗ {test.title}</span> <span className="text-slate-500">({test.file})</span>
              {test.error && <pre className="mt-0.5 whitespace-pre-wrap break-words text-[10px] text-slate-400">{test.error}</pre>}
              {test.page && (
                <details className="mt-0.5" data-testid="page-at-failure">
                  <summary className="cursor-pointer text-[10px] text-slate-500 hover:text-slate-300">What the page showed</summary>
                  <pre className="mt-0.5 whitespace-pre-wrap break-words text-[10px] text-slate-400">{test.page}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="space-y-0.5">
          {others.map((test) => (
            <li key={`${test.file}:${test.title}`} className="text-[11px] text-slate-400">
              {test.status === 'passed' ? '✓' : test.status === 'flaky' ? '≈' : '–'} {test.title} <span className="text-slate-600">({test.status === 'flaky' ? 'passed on a retry' : test.status})</span>
            </li>
          ))}
        </ul>
      )}
      {artifacts.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">What the browser saw</p>
          {artifacts.filter((artifact) => isImage(artifact.name)).map((artifact) => (
            <a key={artifact.id} href={artifactUrl(artifact.id)} target="_blank" rel="noreferrer" className="block">
              <img src={artifactUrl(artifact.id)} alt={artifact.name} className="max-h-64 rounded border border-slate-700" />
            </a>
          ))}
          <ul className="flex flex-wrap gap-2">
            {artifacts.filter((artifact) => !isImage(artifact.name)).map((artifact) => (
              <li key={artifact.id}><a href={artifactUrl(artifact.id)} target="_blank" rel="noreferrer" className="text-[11px] text-sky-300 hover:underline">{artifact.name}</a></li>
            ))}
          </ul>
          {e2e.notKept && e2e.notKept.length > 0 && <p className="text-[10px] text-slate-500">Not kept: {e2e.notKept.join(', ')}</p>}
          <ArtifactStoragePrompt />
        </div>
      )}
      {again.isError && <p className="text-[11px] text-rose-400">{errorMessage(again.error)}</p>}
    </div>
  )
}

export default ReleaseBrowserTests
