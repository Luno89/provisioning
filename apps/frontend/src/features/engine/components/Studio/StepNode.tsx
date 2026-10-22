import { memo, useState } from 'react'
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react'
import { AlertTriangle, CircleAlert, Flag, Layers, Play } from 'lucide-react'
import {
  EXIT_ROW,
  HEADER_HEIGHT,
  NODE_WIDTH,
  SOCKET_ROW,
  nodeHeight,
} from '../../lib/procedure-layout'
import { SOCKET_COLOURS, handleId, type StepNodeData } from '../../lib/procedure-canvas'
import { CATEGORY_COLOURS } from './shared'

type StepNode = Node<StepNodeData, 'step'>

const STATE_RING: Record<NonNullable<StepNodeData['state']>, string> = {
  running: 'ring-2 ring-[var(--leaf-light)] shadow-[0_0_18px_rgba(132,204,22,0.45)]',
  done: 'ring-1 ring-emerald-500/60',
  failed: 'ring-2 ring-red-500',
}

function summaryOf(data: StepNodeData): string {
  if (!data.definition) return ''
  try {
    return data.definition.summarize(data.placed.settings ?? {})
  } catch {
    return ''
  }
}

function StepNodeView({ data, selected }: NodeProps<StepNode>) {
  const [hovered, setHovered] = useState(false)
  const { placed, definition, problems, exposed } = data
  const colour = definition ? CATEGORY_COLOURS[definition.category] : '#ef4444'
  const isValue = definition?.role === 'value'
  const errors = problems.filter((problem) => problem.severity === 'error')
  const height = nodeHeight(definition)
  const rows = Math.max(definition?.inputs.length ?? 0, definition?.outputs.length ?? 0, 1)
  const summary = summaryOf(data)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ width: NODE_WIDTH, height }}
      className={`relative rounded-lg bg-[var(--bark-800)] text-slate-200 text-[11px] shadow-md transition-shadow ${
        isValue ? 'border border-dashed border-slate-600' : 'border border-[var(--bark-600)]'
      } ${selected ? 'outline outline-2 outline-sky-400/80' : ''} ${data.state ? STATE_RING[data.state] : ''}`}
    >
      <NodeToolbar isVisible={hovered} position={Position.Top} offset={definition?.role === 'step' ? 14 : 6}>
        <div className="max-w-xs rounded-md border border-[var(--bark-600)] bg-[var(--bark-900)] px-3 py-2 text-[11px] text-slate-300 shadow-xl">
          <div className="font-semibold text-slate-100">{definition?.title ?? placed.kind}</div>
          <p className="mt-0.5 leading-snug">{definition?.describe ?? `There is no "${placed.kind}" node.`}</p>
          {placed.notes && <p className="mt-1.5 border-t border-[var(--bark-700)] pt-1.5 italic text-slate-400">{placed.notes}</p>}
          {problems.map((problem) => (
            <p key={`${problem.message}-${problem.socket ?? ''}-${problem.exit ?? ''}`} className={`mt-1 ${problem.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
              {problem.socket ? `${problem.socket}: ` : problem.exit ? `${problem.exit}: ` : ''}{problem.message}
            </p>
          ))}
        </div>
      </NodeToolbar>

      {definition?.role === 'step' && (
        <Handle
          type="target"
          id={handleId.enter}
          position={Position.Top}
          className="!h-2.5 !w-6 !rounded-sm !border-0 !bg-slate-300"
          title="Leads here: drag an exit onto this to run this step next"
        />
      )}

      <div
        style={{ height: HEADER_HEIGHT, borderLeftColor: colour }}
        className="flex flex-col justify-center gap-0.5 rounded-t-lg border-b border-[var(--bark-700)] border-l-4 px-2.5"
      >
        <div className="flex items-center gap-1.5">
          {placed.kind === 'group' && <Layers size={11} className="shrink-0 text-fuchsia-300" />}
          <span className="truncate font-semibold text-slate-100">{placed.label ?? definition?.title ?? placed.kind}</span>
          {data.isStart && (
            <span title="The procedure starts here" className="flex items-center gap-0.5 rounded bg-[var(--leaf-stem)]/30 px-1 text-[9px] font-bold uppercase text-[var(--leaf-light)]">
              <Play size={8} /> start
            </span>
          )}
          {data.isCleanup && (
            <span title="Runs last, however the run ends" className="flex items-center gap-0.5 rounded bg-sky-500/20 px-1 text-[9px] font-bold uppercase text-sky-300">
              <Flag size={8} /> cleanup
            </span>
          )}
          {problems.length > 0 && (
            <span className={`ml-auto flex items-center gap-0.5 ${errors.length > 0 ? 'text-red-400' : 'text-amber-400'}`}>
              {errors.length > 0 ? <CircleAlert size={12} /> : <AlertTriangle size={12} />}
              {problems.length}
            </span>
          )}
        </div>
        <div className="truncate text-[10px] text-slate-400">
          <span className="font-mono text-slate-500">{placed.id}</span>
          {summary && <span> · {summary}</span>}
        </div>
      </div>

      <div className="relative" style={{ height: rows * SOCKET_ROW }}>
        {definition?.inputs.map((socket, index) => (
          <div key={`in-${socket.name}`} style={{ top: index * SOCKET_ROW, height: SOCKET_ROW }} className="absolute left-0 flex items-center pl-3" title={`${socket.name} takes ${socket.type}${socket.many ? ' (any number)' : ''}${socket.required ? ', required' : ''}: ${socket.describe}`}>
            <Handle
              type="target"
              id={handleId.input(socket.name)}
              position={Position.Left}
              style={{ top: SOCKET_ROW / 2, background: SOCKET_COLOURS[socket.type] }}
              className={`!h-2.5 !w-2.5 !border-2 !border-[var(--bark-900)] ${socket.many ? '!rounded-sm' : ''}`}
            />
            <span className={socket.required ? 'text-slate-200' : 'text-slate-400'}>{socket.name}</span>
            {exposed.inputs[socket.name] && <span className="ml-1 rounded bg-fuchsia-500/20 px-1 text-[9px] text-fuchsia-300" title="The group passes this in">⇢ {exposed.inputs[socket.name]}</span>}
          </div>
        ))}
        {definition?.outputs.map((socket, index) => (
          <div key={`out-${socket.name}`} style={{ top: index * SOCKET_ROW, height: SOCKET_ROW }} className="absolute right-0 flex items-center pr-3" title={`${socket.name} gives ${socket.type}: ${socket.describe}`}>
            {exposed.outputs[socket.name] && <span className="mr-1 rounded bg-fuchsia-500/20 px-1 text-[9px] text-fuchsia-300" title="The group passes this out">{exposed.outputs[socket.name]} ⇢</span>}
            <span className="text-slate-300">{socket.name}</span>
            <Handle
              type="source"
              id={handleId.output(socket.name)}
              position={Position.Right}
              style={{ top: SOCKET_ROW / 2, background: SOCKET_COLOURS[socket.type] }}
              className="!h-2.5 !w-2.5 !border-2 !border-[var(--bark-900)]"
            />
          </div>
        ))}
      </div>

      {definition && definition.exits.length > 0 && (
        <div style={{ height: EXIT_ROW }} className="absolute bottom-0 left-0 right-0 flex border-t border-[var(--bark-700)]">
          {definition.exits.map((exit) => {
            const unrouted = problems.some((problem) => problem.exit === exit.name && problem.severity === 'error')
            return (
              <div key={exit.name} className="relative flex flex-1 items-start justify-center pt-1" title={`${exit.name}: ${exit.describe}`}>
                <span className={`max-w-full truncate px-0.5 text-[10px] ${unrouted ? 'text-red-300' : exposed.exits[exit.name] ? 'text-fuchsia-300' : 'text-slate-400'}`}>
                  {exit.name}
                </span>
                <Handle
                  type="source"
                  id={handleId.exit(exit.name)}
                  position={Position.Bottom}
                  className={`!h-2.5 !w-2.5 !rotate-45 !rounded-none !border-0 ${unrouted ? '!bg-red-400' : '!bg-slate-300'}`}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default memo(StepNodeView)
