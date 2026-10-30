import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { useCheckDependencies, useDependencies, type ComponentKind, type DependencyFinding, type FindingState } from '../api/dependencies'
import { ageOf, byWhatRuns, componentMatches, countsByState, findingMatches, sortedFindings, STATE_LABEL } from '../lib/dependency-view'

const STATE_STYLE: Record<FindingState, string> = {
  due: 'bg-red-500/15 text-red-300',
  waiting: 'bg-amber-500/15 text-amber-300',
  'no-fix': 'bg-slate-500/20 text-slate-300',
}

const KINDS: (ComponentKind | 'all')[] = ['all', 'npm', 'binary', 'image', 'chart', 'action', 'unpinned']

const shown = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function FindingRow({ finding }: { finding: DependencyFinding }) {
  const where = finding.component.in && finding.component.in !== 'koala' ? ` in ${finding.component.in}` : finding.component.where ? ` on ${finding.component.where}` : ''
  return (
    <li className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] px-3 py-2 text-xs" data-testid={`finding-${finding.advisory.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATE_STYLE[finding.state]}`}>{STATE_LABEL[finding.state]}</span>
        <span className="font-mono text-slate-100">{finding.component.name}@{finding.component.version}</span>
        <span className="text-slate-500">{finding.component.kind}{where}</span>
        <a className="ml-auto font-mono text-sky-300 hover:text-sky-200" href={`https://osv.dev/${encodeURIComponent(finding.advisory.id)}`} target="_blank" rel="noreferrer">{finding.advisory.id}</a>
        {finding.advisory.severity && <span className="text-slate-400">{finding.advisory.severity}</span>}
      </div>
      {finding.advisory.summary && <p className="mt-1 text-slate-400">{finding.advisory.summary}</p>}
      <p className="mt-1 text-slate-400">
        {finding.state === 'no-fix' && 'No fixed version is published yet.'}
        {finding.state === 'waiting' && <>Fixed in <span className="font-mono">{finding.fix}</span>, which can be taken on {finding.takeOn}.</>}
        {finding.state === 'due' && <>Fixed in <span className="font-mono">{finding.fix}</span>{finding.fixPublishedAt ? `, published ${finding.fixPublishedAt.slice(0, 10)}` : ''}: take it with <span className="font-mono">npm run deps:update -- {finding.component.name}</span>.</>}
        {' '}Running in {finding.releases.join(', ')}{finding.instances.length > 0 ? `, on ${finding.instances.join(', ')}` : ''}.
      </p>
    </li>
  )
}

export function DependenciesSection() {
  const dependencies = useDependencies()
  const check = useCheckDependencies()
  const [query, setQuery] = useState('')
  const [state, setState] = useState<FindingState | 'all'>('all')
  const [componentQuery, setComponentQuery] = useState('')
  const [kind, setKind] = useState<ComponentKind | 'all'>('all')
  const [withDev, setWithDev] = useState(false)

  const view = dependencies.data
  const { runtime: findings, devOnly } = byWhatRuns(sortedFindings(view?.findings ?? []))
  const counts = countsByState(findings)
  const now = new Date()
  const components = (view?.check?.components ?? []).filter((component) => componentMatches(component, componentQuery, kind, withDev))

  return (
    <section id="dependencies" className="space-y-3" aria-labelledby="dependencies-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="dependencies-heading" className="text-sm font-semibold">Koala's dependencies</h2>
        <span className="text-xs text-slate-400">
          {view?.check ? `Checked ${shown(view.check.checkedAt)} against OSV` : 'Not checked yet'}
        </span>
        <button
          type="button"
          onClick={() => check.mutate()}
          disabled={check.isPending}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--bark-700)] px-2.5 py-1 text-xs text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-50"
        >
          {check.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check now
        </button>
      </div>
      <p className="text-xs text-slate-400">
        Every package, image, chart, binary and action in each release that root or an instance runs. A fix is taken once it is two weeks old.
      </p>
      {dependencies.isError && <p role="alert" className="text-xs text-red-300">{errorMessage(dependencies.error)}</p>}
      {check.isError && <p role="alert" className="text-xs text-red-300">{errorMessage(check.error)}</p>}
      {view?.check?.problems.map((problem) => <p key={problem} role="status" className="text-xs text-amber-300">{problem}</p>)}

      {view?.check && (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label="Releases checked">
          {view.check.releases.map((release) => (
            <li key={release.release} className="rounded-lg border border-[var(--bark-700)] px-2 py-1 text-slate-300">
              <span className="font-mono text-slate-100">{release.label}</span>
              {release.root ? ' · root' : ''}
              {release.instances.length > 0 ? ` · ${release.instances.length} instance${release.instances.length === 1 ? '' : 's'}` : ''}
              {release.inventory ? ` · ${release.components} components` : ' · no inventory'}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-300">{counts.due} due · {counts.waiting} waiting · {counts['no-fix']} without a fix</span>
        <label className="ml-auto flex items-center gap-1 text-slate-400">
          <span className="sr-only">Search advisories</span>
          <input id="finding-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Package, advisory, release or instance" className="rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-slate-100" />
        </label>
        <select id="finding-state" aria-label="Show advisories" value={state} onChange={(event) => setState(event.target.value as FindingState | 'all')} className="rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-slate-100">
          <option value="all">Every state</option>
          <option value="due">{STATE_LABEL.due}</option>
          <option value="waiting">{STATE_LABEL.waiting}</option>
          <option value="no-fix">{STATE_LABEL['no-fix']}</option>
        </select>
      </div>
      {findings.length === 0 && view?.check && <p className="text-xs text-slate-400">No known advisory affects a running release.</p>}
      <ul className="space-y-2">
        {findings.filter((finding) => findingMatches(finding, query, state)).map((finding) => <FindingRow key={finding.key} finding={finding} />)}
      </ul>
      {devOnly.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-300">Development tools only ({devOnly.length})</summary>
          <p className="mt-1 text-slate-400">Packages only Koala's development and tests use. Koala never runs them, so they are not emailed and never hold up a release.</p>
          <ul className="mt-2 space-y-2">
            {devOnly.filter((finding) => findingMatches(finding, query, state)).map((finding) => <FindingRow key={finding.key} finding={finding} />)}
          </ul>
        </details>
      )}

      {view?.check && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-300">Everything root's release is made of ({view.check.components.length})</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input id="component-search" aria-label="Search components" value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)} placeholder="Name or version" className="rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-slate-100" />
            <select id="component-kind" aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as ComponentKind | 'all')} className="rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-slate-100">
              {KINDS.map((entry) => <option key={entry} value={entry}>{entry === 'all' ? 'Every kind' : entry}</option>)}
            </select>
            <label className="flex items-center gap-1 text-slate-400">
              <input id="component-dev" type="checkbox" checked={withDev} onChange={(event) => setWithDev(event.target.checked)} /> Development-only packages
            </label>
          </div>
          <div className="mt-2 max-h-96 overflow-auto">
            <table className="w-full text-left">
              <thead className="text-slate-500"><tr><th className="py-1 pr-3 font-normal">Name</th><th className="py-1 pr-3 font-normal">Version</th><th className="py-1 pr-3 font-normal">Kind</th><th className="py-1 pr-3 font-normal">Age</th><th className="py-1 font-normal">OSV</th></tr></thead>
              <tbody>
                {components.map((component) => (
                  <tr key={`${component.in ?? component.kind}:${component.name}@${component.version ?? ''}#${component.where ?? ''}`} className="border-t border-[var(--bark-700)]">
                    <td className="py-1 pr-3 font-mono text-slate-200">{component.name}{component.in && component.in !== 'koala' ? <span className="text-slate-500"> ({component.in})</span> : null}</td>
                    <td className="py-1 pr-3 font-mono text-slate-300">{component.version ?? 'unpinned'}</td>
                    <td className="py-1 pr-3 text-slate-400">{component.kind}{component.where ? ` · ${component.where}` : ''}</td>
                    <td className="py-1 pr-3 text-slate-400">{ageOf(component.publishedAt, now) ?? '—'}</td>
                    <td className="py-1 text-slate-400">{component.checked ? 'checked' : 'not checked by OSV'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}
