import { useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Package } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { useDependencies, useRemoveDependency, useSaveDependency, type DependencyView } from '../../api/workspaceDependencies'
import Explorer, { FileHeader, type ExplorerGroup } from './Explorer'
import NeedsPicker from '../NeedsPicker'
import { INSTALL_MANAGERS, dependencyForm, dependencyOf, installLines, usedByLines, type DependencyForm, type InstallForm } from './dependency-forms'

const field = 'w-full rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200'
const label = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400'
const button = 'rounded border border-[var(--bark-600)] px-2 py-1 text-xs text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-50'
const primary = 'rounded bg-[var(--leaf-stem)] px-2.5 py-1 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50'

export default function DependencyExplorer() {
  const { name } = useParams({ strict: false }) as { name?: string }
  const dependencies = useDependencies()
  const [adding, setAdding] = useState<string | undefined>()
  const all = dependencies.data ?? []
  const chosen = all.find((dependency) => dependency.name === name)

  const groups: ExplorerGroup[] = [
    { id: 'mine', title: 'Yours', items: all.filter((dependency) => dependency.mine) },
    { id: 'shipped', title: 'Shipped with Koala', items: all.filter((dependency) => !dependency.mine) },
  ].filter((group) => group.items.length > 0).map((group) => ({
    id: group.id,
    title: group.title,
    items: group.items.map((dependency) => ({
      id: dependency.name,
      label: dependency.name,
      mono: true,
      mine: dependency.mine,
      icon: Package,
      link: { to: '/studio/dependencies/$name', params: { name: dependency.name } },
      files: [],
    })),
  }))

  return (
    <Explorer
      title="Dependencies"
      groups={groups}
      selected={name ? { item: name } : undefined}
      path={[{ label: 'Dependencies', link: { to: '/studio/dependencies' } }, ...(name ? [{ label: name }] : [])]}
      onNew={(fresh) => setAdding(fresh)}
      newPlaceholder="New dependency's name, then Enter"
      loading={dependencies.isPending}
      error={dependencies.isError ? errorMessage(dependencies.error) : undefined}
    >
      {adding !== undefined ? (
        <Editor key={`new-${adding}`} form={dependencyForm({ name: adding })} fresh onDone={() => setAdding(undefined)} />
      ) : !name ? (
        <Landing />
      ) : dependencies.isPending ? null : !chosen ? (
        <p className="text-sm text-slate-400">There is no dependency called {name}.</p>
      ) : chosen.mine ? (
        <Editor key={chosen.name} form={dependencyForm(chosen)} view={chosen} />
      ) : (
        <Shipped dependency={chosen} />
      )}
    </Explorer>
  )
}

function Landing() {
  return (
    <div className="max-w-3xl space-y-3 pt-4 text-sm text-slate-400">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-200"><Package size={20} className="text-[var(--leaf)]" /> Dependencies</h1>
      <p>A dependency is something a workspace can have: how it is installed, and the programs or libraries it puts there. Tools, MCP servers, procedure steps, checks and a project&apos;s <span className="font-mono">.koala/workspace.json</span> name the dependencies they need, and each workspace image is built from them, each installed once, with what they need first.</p>
      <p>After every build Koala checks each one put in what it said it would, so a workspace never says it has something it does not. Add your own with the name box above; one that runs a script waits for your approval before a tree&apos;s workspace is built with it.</p>
    </div>
  )
}

function UsedBy({ view }: { view: DependencyView }) {
  const lines = usedByLines(view)
  return (
    <section className="space-y-1">
      <span className={label}>Used by</span>
      {lines.length === 0 ? <p className="text-xs text-slate-500">Nothing names it yet.</p> : <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-300">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
    </section>
  )
}

function Shipped({ dependency }: { dependency: DependencyView }) {
  return (
    <div className="max-w-3xl space-y-4">
      <FileHeader title={dependency.name} says={`${dependency.summary} Shipped with Koala, so it cannot be changed here.`} />
      <section className="space-y-1 text-xs text-slate-300">
        {dependency.provides.length > 0 && <p><span className={label}>Puts on the PATH</span> <span className="font-mono">{dependency.provides.join(', ')}</span></p>}
        {dependency.libraries?.length ? <p><span className={label}>Libraries</span> <span className="font-mono">{dependency.libraries.join(', ')}</span></p> : null}
        {dependency.needs?.length ? <p><span className={label}>Needs first</span> <span className="font-mono">{dependency.needs.join(', ')}</span></p> : null}
      </section>
      <section className="space-y-1">
        <span className={label}>How it is installed</span>
        <pre className="whitespace-pre-wrap rounded bg-[var(--bark-950)] p-2 font-mono text-[11px] text-slate-300">{installLines(dependency.install).join('\n')}</pre>
        {dependency.onDebian?.length ? <pre className="whitespace-pre-wrap rounded bg-[var(--bark-950)] p-2 font-mono text-[11px] text-slate-400">{`On a Debian base:\n${installLines(dependency.onDebian).join('\n')}`}</pre> : null}
      </section>
      <UsedBy view={dependency} />
    </div>
  )
}

function InstallFields({ title, form, onChange }: { title: string; form: InstallForm; onChange: (form: InstallForm) => void }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className={label}>{title}</legend>
      <div className="grid grid-cols-[3rem_1fr] items-center gap-x-2 gap-y-1">
        {INSTALL_MANAGERS.map((manager) => (
          <label key={manager} className="contents">
            <span className="text-xs text-slate-500">{manager}</span>
            <input aria-label={`${title}: ${manager} packages`} className={`${field} font-mono`} value={form.packages[manager] ?? ''} onChange={(event) => onChange({ ...form, packages: { ...form.packages, [manager]: event.target.value } })} placeholder="packages, by name" />
          </label>
        ))}
      </div>
      <textarea aria-label={`${title}: script`} rows={3} className={`${field} font-mono`} value={form.script} onChange={(event) => onChange({ ...form, script: event.target.value })} placeholder="commands run as root while the image is built" />
    </fieldset>
  )
}

function Editor({ form: initial, view, fresh = false, onDone }: { form: DependencyForm; view?: DependencyView | undefined; fresh?: boolean; onDone?: () => void }) {
  const navigate = useNavigate()
  const [form, setForm] = useState(initial)
  const [problems, setProblems] = useState<string[]>([])
  const save = useSaveDependency((saved) => {
    setProblems([])
    onDone?.()
    void navigate({ to: '/studio/dependencies/$name', params: { name: saved.name } })
  })
  const remove = useRemoveDependency(() => void navigate({ to: '/studio/dependencies' }))
  const set = <K extends keyof DependencyForm>(key: K, value: DependencyForm[K]) => setForm((current) => ({ ...current, [key]: value }))
  const failure = (err: unknown) => {
    const said = (err as { response?: { data?: { problems?: string[] } } }).response?.data?.problems
    setProblems(said?.length ? said : [errorMessage(err)])
  }

  return (
    <div className="max-w-3xl space-y-4">
      <FileHeader title={form.name} says={fresh ? 'A new dependency of your own.' : 'Yours. Saving rebuilds every workspace that uses it.'} />
      <label className="block space-y-1">
        <span className={label}>What it gives a workspace, in one line</span>
        <input aria-label="Summary" className={field} value={form.summary} onChange={(event) => set('summary', event.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={label}>Programs it puts on the PATH</span>
          <input aria-label="Programs" className={`${field} font-mono`} value={form.provides} onChange={(event) => set('provides', event.target.value)} placeholder="pdftotext, pdfinfo" />
        </label>
        <label className="space-y-1">
          <span className={label}>Or the libraries it adds</span>
          <input aria-label="Libraries" className={`${field} font-mono`} value={form.libraries} onChange={(event) => set('libraries', event.target.value)} placeholder="libfoo.so.1" />
        </label>
      </div>
      <NeedsPicker label="Needs first" value={form.needs} onChange={(needs) => set('needs', needs.filter((need) => need !== form.name))} />
      <InstallFields title="Install" form={form.install} onChange={(install) => set('install', install)} />
      <InstallFields title="On a Debian base, instead" form={form.onDebian} onChange={(onDebian) => set('onDebian', onDebian)} />
      <p className="text-[11px] text-amber-300">A script runs as root while the image is built; a tree&apos;s workspace waits for your approval before it is built with a new one.</p>
      {problems.length > 0 && <ul role="alert" className="list-disc space-y-0.5 pl-5 text-xs text-rose-300">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      <div className="flex items-center gap-2">
        <button type="button" className={primary} disabled={save.isPending} onClick={() => save.mutate(dependencyOf(form), { onError: failure })}>{save.isPending ? 'Saving…' : 'Save'}</button>
        {fresh && <button type="button" className={button} onClick={() => onDone?.()}>Cancel</button>}
        {!fresh && <button type="button" className={button} disabled={remove.isPending} onClick={() => remove.mutate(form.name, { onError: failure })}>Delete</button>}
      </div>
      {view && <UsedBy view={view} />}
    </div>
  )
}
