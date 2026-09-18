import type { ReactNode } from 'react'
import { Flag, FolderOpen, Layers, Play, Trash2, Ungroup } from 'lucide-react'
import {
  settingsProblems,
  type NodeDefinition,
  type Procedure,
  type ProcedureProblem,
} from '@koala/agent-engine/procedure'
import {
  bodyAt,
  definitionOf,
  isRefused,
  libraryOf,
  removeNodes,
  setCleanup,
  setStart,
  SOCKET_COLOURS,
  updateNode,
  type GroupPath,
} from '../../lib/procedure-canvas'
import { groupSelection, ungroup, updateGroup } from '../../lib/procedure-grouping'
import { BUDGET_FIELDS, withBudget } from '../../lib/procedure-drafts'
import SettingsFields from './SettingsFields'
import TrackRecords from './TrackRecords'
import { CATEGORY_COLOURS, CATEGORY_TITLES, PLACEMENT_TITLES, STUDIO_CONTEXT } from './shared'

const input = 'w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)] disabled:opacity-60'
const action = 'flex items-center gap-1.5 rounded-md border border-[var(--bark-600)] px-2 py-1 text-[11px] text-slate-300 hover:bg-[var(--bark-700)] disabled:cursor-not-allowed disabled:opacity-40'

export interface InspectorProps {
  procedure: Procedure
  path: GroupPath
  selection: readonly string[]
  editable: boolean
  problems: readonly ProcedureProblem[]
  onChange: (next: Procedure, mergeKey?: string) => void
  onSelect: (ids: string[]) => void
  onOpenGroup: (groupId: string) => void
  onRefused: (message: string) => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-[var(--bark-700)] px-3 py-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      {children}
    </section>
  )
}

function Labelled({ label, describe, children }: { label: string; describe?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-medium text-slate-300">{label}</span>
      {describe && <span className="block text-[10px] leading-snug text-slate-500">{describe}</span>}
      {children}
    </label>
  )
}

function Sockets({ definition }: { definition: NodeDefinition }) {
  const row = (name: string, detail: string, describe: string, colour?: string) => (
    <li key={name} className="text-[11px]">
      <span className="flex items-center gap-1.5">
        {colour && <span className="h-2 w-2 rounded-full" style={{ background: colour }} />}
        <span className="font-mono text-slate-200">{name}</span>
        <span className="text-slate-500">{detail}</span>
      </span>
      <span className="block pl-3.5 text-[10px] leading-snug text-slate-500">{describe}</span>
    </li>
  )
  return (
    <>
      {definition.inputs.length > 0 && (
        <Section title="Takes">
          <ul className="space-y-1.5">
            {definition.inputs.map((socket) => row(socket.name, `${socket.type}${socket.many ? ', any number' : ''}${socket.required ? ', required' : ''}`, socket.describe, SOCKET_COLOURS[socket.type]))}
          </ul>
        </Section>
      )}
      {definition.outputs.length > 0 && (
        <Section title="Gives">
          <ul className="space-y-1.5">
            {definition.outputs.map((socket) => row(socket.name, socket.type, socket.describe, SOCKET_COLOURS[socket.type]))}
          </ul>
        </Section>
      )}
      {definition.exits.length > 0 && (
        <Section title="Leaves through">
          <ul className="space-y-1.5">
            {definition.exits.map((exit) => row(exit.name, '', exit.describe))}
          </ul>
        </Section>
      )}
    </>
  )
}

export default function Inspector(props: InspectorProps) {
  const { procedure, path, selection, editable, onChange, onRefused, onSelect } = props
  const body = bodyAt(procedure, path, STUDIO_CONTEXT)
  const selected = body?.nodes.filter((node) => selection.includes(node.id)) ?? []

  const apply = (next: Procedure | { refused: string }) => {
    if (isRefused(next)) onRefused(next.refused)
    else onChange(next)
  }

  if (selected.length > 1) {
    return (
      <aside className="h-full w-80 shrink-0 overflow-y-auto border-l border-[var(--bark-700)] bg-[var(--bark-900)]">
        <Section title={`${selected.length} nodes selected`}>
          <p className="text-[11px] text-slate-400">Group them to fold them into one node, with whatever crosses the edge becoming the group's sockets and exits.</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={!editable}
              className={action}
              onClick={() => {
                const grouped = groupSelection(procedure, path, selection, STUDIO_CONTEXT)
                if (isRefused(grouped)) return onRefused(grouped.refused)
                onChange(grouped.procedure)
                onSelect([grouped.nodeId])
              }}
            >
              <Layers size={12} /> Group
            </button>
            <button type="button" disabled={!editable} className={action} onClick={() => { onChange(removeNodes(procedure, path, selection, STUDIO_CONTEXT)); onSelect([]) }}>
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </Section>
      </aside>
    )
  }

  const node = selected[0]
  if (node) {
    const definition = definitionOf(node, procedure, STUDIO_CONTEXT)
    const nodeProblems = props.problems.filter((problem) => problem.node === node.id && problem.group === (path.length ? path[path.length - 1] : undefined))
    const settingErrors = definition ? settingsProblems(definition.settings, node.settings ?? {}) : []
    const isStep = definition?.role === 'step'

    return (
      <aside className="h-full w-80 shrink-0 overflow-y-auto border-l border-[var(--bark-700)] bg-[var(--bark-900)]">
        <div className="border-b border-[var(--bark-700)] px-3 py-3" style={{ borderTop: `3px solid ${definition ? CATEGORY_COLOURS[definition.category] : '#ef4444'}` }}>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100">{definition?.title ?? node.kind}</h2>
            <span className="rounded bg-[var(--bark-700)] px-1.5 text-[10px] text-slate-400">{definition ? CATEGORY_TITLES[definition.category] : 'unknown'}</span>
            <span className={`rounded px-1.5 text-[10px] ${isStep ? 'bg-sky-500/15 text-sky-300' : 'border border-dashed border-slate-600 text-slate-400'}`}>{isStep ? 'step' : 'value'}</span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-slate-400">{definition?.describe ?? `There is no "${node.kind}" node.`}</p>
          {definition && (
            <p className="mt-1 text-[10px] text-slate-500">
              {isStep ? 'Runs when a flow leads here' : 'Worked out whenever a step needs what it gives'}, and {PLACEMENT_TITLES[definition.runs] ?? definition.runs}.
            </p>
          )}
          <p className="mt-1 font-mono text-[10px] text-slate-500">{node.id} · {node.kind}{node.group ? ` · ${node.group}` : ''}</p>
        </div>

        {nodeProblems.length > 0 && (
          <Section title="Problems">
            <ul className="space-y-1">
              {nodeProblems.map((problem, index) => (
                <li key={index} className={`text-[11px] ${problem.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
                  {problem.socket ? `${problem.socket}: ` : problem.exit ? `${problem.exit}: ` : ''}{problem.message}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="On this canvas">
          <Labelled label="Label" describe="Shown instead of the node's title">
            <input className={input} value={node.label ?? ''} disabled={!editable} placeholder={definition?.title} onChange={(event) => onChange(updateNode(procedure, path, node.id, { label: event.target.value }, STUDIO_CONTEXT), `label:${node.id}`)} />
          </Labelled>
          <Labelled label="Notes" describe="Why this node is here, for whoever reads the procedure next">
            <textarea className={`${input} min-h-14`} value={node.notes ?? ''} disabled={!editable} onChange={(event) => onChange(updateNode(procedure, path, node.id, { notes: event.target.value }, STUDIO_CONTEXT), `notes:${node.id}`)} />
          </Labelled>
          <div className="flex flex-wrap gap-1.5">
            {isStep && (
              <button type="button" className={action} disabled={!editable || body?.start === node.id} onClick={() => apply(setStart(procedure, path, node.id, STUDIO_CONTEXT))}>
                <Play size={12} /> {body?.start === node.id ? 'Starts here' : 'Start here'}
              </button>
            )}
            {isStep && path.length === 0 && (
              procedure.cleanup === node.id ? (
                <button type="button" className={action} disabled={!editable} onClick={() => apply(setCleanup(procedure, undefined, STUDIO_CONTEXT))}>
                  <Flag size={12} /> Stop being the cleanup
                </button>
              ) : (
                <button type="button" className={action} disabled={!editable} onClick={() => apply(setCleanup(procedure, node.id, STUDIO_CONTEXT))} title="The cleanup runs last, however the run ends">
                  <Flag size={12} /> Make the cleanup
                </button>
              )
            )}
            {node.group && (
              <button type="button" className={action} onClick={() => props.onOpenGroup(node.group!)}>
                <FolderOpen size={12} /> Open group
              </button>
            )}
            {node.group && (
              <button
                type="button"
                className={action}
                disabled={!editable}
                title="Put this group's nodes directly on this canvas, where they can be edited"
                onClick={() => {
                  const result = ungroup(procedure, path, node.id, STUDIO_CONTEXT)
                  if (isRefused(result)) return onRefused(result.refused)
                  onChange(result.procedure)
                  onSelect(result.nodeIds)
                }}
              >
                <Ungroup size={12} /> Ungroup
              </button>
            )}
            <button type="button" className={`${action} hover:!text-red-300`} disabled={!editable} onClick={() => { onChange(removeNodes(procedure, path, [node.id], STUDIO_CONTEXT)); onSelect([]) }}>
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </Section>

        {definition && Object.keys(definition.settings.properties).length > 0 && (
          <Section title="Settings">
            <div className="space-y-3">
              <SettingsFields
                schema={definition.settings}
                value={node.settings}
                disabled={!editable}
                onChange={(settings) => onChange(updateNode(procedure, path, node.id, { settings }, STUDIO_CONTEXT), `settings:${node.id}`)}
              />
            </div>
            {settingErrors.map((message) => <p key={message} className="text-[11px] text-red-300">{message}</p>)}
          </Section>
        )}

        {definition && <Sockets definition={definition} />}
      </aside>
    )
  }

  if (path.length > 0) {
    const group = libraryOf(procedure, STUDIO_CONTEXT).get(path[path.length - 1]!)
    if (!group) return null
    return (
      <aside className="h-full w-80 shrink-0 overflow-y-auto border-l border-[var(--bark-700)] bg-[var(--bark-900)]">
        <Section title="Group">
          {!editable && <p className="rounded-md bg-sky-500/10 px-2 py-1.5 text-[11px] text-sky-200">A built-in group, shown so you can see what it does. To change it, go back up and use Ungroup on its node — that copies its nodes onto your canvas.</p>}
          <Labelled label="Title">
            <input className={input} value={group.title} disabled={!editable} onChange={(event) => onChange(updateGroup(procedure, group.id, { title: event.target.value }), `group-title:${group.id}`)} />
          </Labelled>
          <Labelled label="What it does" describe="Shown when someone hovers over the group's node">
            <textarea className={`${input} min-h-16`} value={group.describe} disabled={!editable} onChange={(event) => onChange(updateGroup(procedure, group.id, { describe: event.target.value }), `group-describe:${group.id}`)} />
          </Labelled>
        </Section>
        <Section title="Passes in">
          {group.inputs.length === 0 && <p className="text-[11px] text-slate-500">Nothing.</p>}
          <ul className="space-y-1.5">
            {group.inputs.map((socket) => (
              <li key={socket.name} className="text-[11px]">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: SOCKET_COLOURS[socket.type] }} /><span className="font-mono text-slate-200">{socket.name}</span><span className="text-slate-500">{socket.type}</span></span>
                <span className="block pl-3.5 text-[10px] text-slate-500">into {socket.to.map((ref) => `${ref.node}.${ref.socket}`).join(', ') || 'nothing yet'}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Passes out">
          {group.outputs.length === 0 && <p className="text-[11px] text-slate-500">Nothing.</p>}
          <ul className="space-y-1.5">
            {group.outputs.map((socket) => (
              <li key={socket.name} className="text-[11px]">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: SOCKET_COLOURS[socket.type] }} /><span className="font-mono text-slate-200">{socket.name}</span><span className="text-slate-500">{socket.type}</span></span>
                <span className="block pl-3.5 text-[10px] text-slate-500">from {socket.from.node}.{socket.from.socket}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Leaves through">
          <ul className="space-y-1.5">
            {group.exits.map((exit) => (
              <li key={exit.name} className="text-[11px]">
                <span className="font-mono text-slate-200">{exit.name}</span>
                <span className="block text-[10px] text-slate-500">when {exit.from.node} leaves through {exit.from.exit}</span>
              </li>
            ))}
          </ul>
        </Section>
      </aside>
    )
  }

  return (
    <aside className="h-full w-80 shrink-0 overflow-y-auto border-l border-[var(--bark-700)] bg-[var(--bark-900)]">
      <Section title="Procedure">
        <Labelled label="Name">
          <input className={input} value={procedure.name} onChange={(event) => onChange({ ...procedure, name: event.target.value }, 'procedure-name')} />
        </Labelled>
        <Labelled label="What it does" describe="Agents and the agent builder read this to pick a procedure">
          <textarea className={`${input} min-h-20`} value={procedure.describe} onChange={(event) => onChange({ ...procedure, describe: event.target.value }, 'procedure-describe')} />
        </Labelled>
        <p className="font-mono text-[10px] text-slate-500">id {procedure.id} · version {procedure.version}</p>
      </Section>
      <Section title="How long a run may go">
        <TrackRecords procedureId={procedure.id} />
      </Section>
      <Section title="Hard limits">
        <p className="text-[10px] leading-snug text-slate-500">Usually left empty. A value set here caps every run, whatever the model has needed before.</p>
        <div className="grid grid-cols-2 gap-2">
          {BUDGET_FIELDS.map((budget) => (
            <Labelled key={budget.key} label={budget.label}>
              <input
                type="number"
                min={0}
                className={input}
                title={budget.describe}
                value={procedure.budget[budget.key] ?? ''}
                onChange={(event) => onChange(withBudget(procedure, budget.key, event.target.value === '' ? undefined : Number(event.target.value)), `budget:${budget.key}`)}
              />
            </Labelled>
          ))}
        </div>
      </Section>
      <Section title="Tips">
        <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-slate-400">
          <li>Drag from a coloured socket to another of the same colour to pass data.</li>
          <li>Drag from a diamond exit to the bar on top of a step to choose what runs next.</li>
          <li>Double-click a group to open it. Shift-drag to select several nodes, then group them.</li>
          <li>Delete or Backspace removes what is selected. Ctrl+Z undoes, Ctrl+S saves.</li>
        </ul>
      </Section>
    </aside>
  )
}
