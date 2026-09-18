import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Procedure, ProcedureProblem } from '@koala/agent-engine/procedure'
import {
  addNode,
  connect,
  isRefused,
  moveNodes,
  removeEdges,
  removeNodes,
  toCanvas,
  type GroupPath,
  type StepNodeData,
} from '../../lib/procedure-canvas'
import type { NodeState } from '../../lib/procedure-run'
import StepNode from './StepNode'
import { FlowEdge, WireEdge } from './CanvasEdges'
import { CATEGORY_COLOURS, NODE_DRAG_TYPE, STUDIO_CONTEXT } from './shared'

const NODE_TYPES = { step: StepNode }
const EDGE_TYPES = { wire: WireEdge, flow: FlowEdge }

export interface ProcedureCanvasProps {
  procedure: Procedure
  path: GroupPath
  problems: readonly ProcedureProblem[]
  states: Readonly<Record<string, NodeState>>
  selection: readonly string[]
  editable: boolean
  onChange: (next: Procedure, mergeKey?: string) => void
  onSelect: (ids: string[]) => void
  onOpenGroup: (groupId: string) => void
  onRefused: (message: string) => void
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index])

export default function ProcedureCanvas({
  procedure,
  path,
  problems,
  states,
  selection,
  editable,
  onChange,
  onSelect,
  onOpenGroup,
  onRefused,
}: ProcedureCanvasProps) {
  const flow = useReactFlow()
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({})
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const drag = useRef(0)

  const drawn = useMemo(() => toCanvas(procedure, path, problems, STUDIO_CONTEXT, states), [procedure, path, problems, states])

  const nodes = useMemo<Node<StepNodeData, 'step'>[]>(
    () => drawn.nodes.map((node) => ({
      ...node,
      selected: selection.includes(node.id),
      ...(measured[node.id] ? { measured: measured[node.id] } : {}),
    })),
    [drawn.nodes, selection, measured],
  )

  const edges = useMemo<Edge[]>(
    () => drawn.edges.map((edge) => ({
      ...edge,
      selected: selectedEdges.includes(edge.id),
      ...(edge.type === 'flow' ? { markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1', width: 16, height: 16 } } : {}),
    })),
    [drawn.edges, selectedEdges],
  )

  const onNodesChange = useCallback((changes: NodeChange<Node<StepNodeData, 'step'>>[]) => {
    const sizes: Record<string, { width: number; height: number }> = {}
    const positions: Record<string, { x: number; y: number }> = {}
    const picked = new Set(selection)
    let selectionChanged = false
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) sizes[change.id] = change.dimensions
      if (change.type === 'position' && change.position) positions[change.id] = change.position
      if (change.type === 'select' && picked.has(change.id) !== change.selected) {
        if (change.selected) picked.add(change.id)
        else picked.delete(change.id)
        selectionChanged = true
      }
    }
    if (Object.keys(sizes).length > 0) {
      setMeasured((current) => {
        const changed = Object.entries(sizes).filter(([id, size]) => current[id]?.width !== size.width || current[id]?.height !== size.height)
        return changed.length === 0 ? current : { ...current, ...Object.fromEntries(changed) }
      })
    }
    if (selectionChanged) onSelect([...picked])
    if (editable && Object.keys(positions).length > 0) {
      onChange(moveNodes(procedure, path, positions, STUDIO_CONTEXT), `drag:${drag.current}`)
    }
  }, [editable, onChange, onSelect, procedure, path, selection])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdges((current) => {
      const picked = new Set(current)
      for (const change of changes) {
        if (change.type !== 'select') continue
        if (change.selected) picked.add(change.id)
        else picked.delete(change.id)
      }
      return sameIds([...picked], current) ? current : [...picked]
    })
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    const next = connect(procedure, path, connection, STUDIO_CONTEXT)
    if (isRefused(next)) onRefused(next.refused)
    else onChange(next)
  }, [procedure, path, onChange, onRefused])

  const onDelete = useCallback(({ nodes: goneNodes, edges: goneEdges }: { nodes: Node[]; edges: Edge[] }) => {
    const withoutNodes = removeNodes(procedure, path, goneNodes.map((node) => node.id), STUDIO_CONTEXT)
    onChange(removeEdges(withoutNodes, path, goneEdges.map((edge) => edge.id), STUDIO_CONTEXT))
    onSelect([])
  }, [procedure, path, onChange, onSelect])

  const onDrop = useCallback((event: DragEvent) => {
    event.preventDefault()
    const raw = event.dataTransfer.getData(NODE_DRAG_TYPE)
    if (!raw || !editable) return
    const { kind, group } = JSON.parse(raw) as { kind: string; group?: string }
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const added = addNode(procedure, path, kind, position, STUDIO_CONTEXT, group)
    if (isRefused(added)) {
      onRefused(added.refused)
      return
    }
    onChange(added.procedure)
    onSelect([added.id])
  }, [editable, flow, procedure, path, onChange, onSelect, onRefused])

  return (
    <ReactFlow
      key={path.join('/')}
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onDelete={onDelete}
      onNodeDragStart={() => { drag.current += 1 }}
      onNodeDoubleClick={(_event, node) => {
        const group = (node.data as StepNodeData).placed.group
        if (group) onOpenGroup(group)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = editable ? 'copy' : 'none'
      }}
      onDrop={onDrop}
      nodesDraggable={editable}
      nodesConnectable={editable}
      edgesFocusable={editable}
      deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
      multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
      selectionKeyCode="Shift"
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.15}
      maxZoom={2}
      colorMode="dark"
      proOptions={{ hideAttribution: true }}
      className="bg-[var(--bark-900)]"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#3b423b" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) => {
          const data = node.data as StepNodeData
          return data.definition ? CATEGORY_COLOURS[data.definition.category] : '#ef4444'
        }}
        maskColor="rgba(10, 12, 10, 0.7)"
        className="!bg-[var(--bark-800)]"
      />
    </ReactFlow>
  )
}
