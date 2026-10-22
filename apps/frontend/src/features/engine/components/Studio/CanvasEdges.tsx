import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { CanvasEdge } from '../../lib/procedure-canvas'

type StudioEdge = Edge<CanvasEdge['data']>

export function WireEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<StudioEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return (
    <BaseEdge
      path={path}
      {...(markerEnd ? { markerEnd } : {})}
      style={{ stroke: data?.colour ?? '#e5e7eb', strokeWidth: selected ? 3 : 1.5, opacity: selected ? 1 : 0.7 }}
    />
  )
}

export function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<StudioEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12, offset: 18 })
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        style={{ stroke: selected ? '#38bdf8' : '#cbd5e1', strokeWidth: selected ? 3 : 2 }}
      />
      {selected && data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="pointer-events-none absolute rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-200"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
