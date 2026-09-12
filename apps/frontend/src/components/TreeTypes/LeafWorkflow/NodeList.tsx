import { useState } from 'react';
import {
  DndContext, DragOverlay, closestCenter, useDroppable, useSensor, useSensors,
  PointerSensor, KeyboardSensor,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown, ChevronRight, Plus, Trash2, RefreshCw, CornerDownRight,
  GripVertical, Folder, Repeat,
} from 'lucide-react';
import {
  card, field, WORKFLOW_STAGE_TYPES, isWorkflowContainerNode,
  type WorkflowStageNode, type WorkflowStageType,
} from '../shared.js';
import { STAGE_LABELS, blankStage, blankGroup, blankLoop, LOOP_TYPE_LABELS } from './stageTemplates.js';
import { StageEditor } from './StageEditor.js';
import { GroupLoopEditor, type GroupLoopPatch } from './GroupLoopEditor.js';
import {
  findNode, parentIdOf, childrenOf, updateNode, removeNode, insertNode, moveNode,
  nodesBefore, subtreeContainsId, clearWorkflowReferences,
} from './tree-ops.js';

type AddKind = WorkflowStageType | 'group' | 'loop';

const endZoneId = (scope: string, parentId: string | null) => (parentId === null ? `end:${scope}:root` : `end:${scope}:${parentId}`);

function resolveDrop(tree: WorkflowStageNode[], overId: string, scope: string): { parentId: string | null; index: number } | null {
  const prefix = `end:${scope}:`;
  if (overId.startsWith(prefix)) {
    const raw = overId.slice(prefix.length);
    const parentId = raw === 'root' ? null : raw;
    const siblings = childrenOf(tree, parentId) ?? [];
    return { parentId, index: siblings.length };
  }
  const parentId = parentIdOf(tree, overId);
  if (parentId === undefined) return null;
  const siblings = childrenOf(tree, parentId) ?? [];
  const index = siblings.findIndex((n) => n.id === overId);
  return { parentId, index: index === -1 ? siblings.length : index };
}

export function NodeList({ scope, nodes, onChange }: {
  scope: string;
  nodes: WorkflowStageNode[];
  onChange: (next: WorkflowStageNode[]) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const patchNode = (id: string, patch: Record<string, unknown>) =>
    onChange(updateNode(nodes, id, (n) => ({ ...n, ...patch }) as WorkflowStageNode));

  const removeById = (id: string) => {
    const { nodes: without } = removeNode(nodes, id);
    onChange(clearWorkflowReferences(without, id));
  };

  const addAt = (parentId: string | null, kind: AddKind) => {
    const node = kind === 'group' ? blankGroup() : kind === 'loop' ? blankLoop() : blankStage(kind);
    const siblings = childrenOf(nodes, parentId) ?? [];
    onChange(insertNode(nodes, parentId, siblings.length, node));
    setOpenId(node.id);
  };

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activeId2 = String(active.id);
    const overId = String(over.id);
    if (activeId2 === overId) return;

    const dragged = findNode(nodes, activeId2);
    if (!dragged) return;

    const drop = resolveDrop(nodes, overId, scope);
    if (!drop) return;
    if (drop.parentId !== null && subtreeContainsId(dragged, drop.parentId)) return;

    const activeParentId = parentIdOf(nodes, activeId2) ?? null;
    const activeSiblings = childrenOf(nodes, activeParentId) ?? [];
    const activeIndex = activeSiblings.findIndex((n) => n.id === activeId2);

    let targetIndex = drop.index;
    if (activeParentId === drop.parentId && activeIndex !== -1 && activeIndex < targetIndex) {
      targetIndex -= 1;
    }

    onChange(moveNode(nodes, activeId2, drop.parentId, targetIndex));
  };

  const activeNode = activeId ? findNode(nodes, activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {nodes.length === 0 && (
        <p className="text-[12px] text-slate-500 italic mb-3">No stages — nothing runs here. Add one below.</p>
      )}

      <NodeLevel
        scope={scope} nodes={nodes} parentId={null} tree={nodes}
        openId={openId} setOpenId={setOpenId}
        onPatch={patchNode} onRemove={removeById} onAddAt={addAt}
      />

      <AddRow onAdd={(kind) => addAt(null, kind)} />

      <DragOverlay>
        {activeNode ? <DragPreview node={activeNode} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function DragPreview({ node }: { node: WorkflowStageNode }) {
  const isContainer = isWorkflowContainerNode(node);
  return (
    <div className={`${card} px-3 py-2 shadow-lg flex items-center gap-2 opacity-90`}>
      {isContainer
        ? (node.containerType === 'loop' ? <Repeat size={14} className="text-purple-300" /> : <Folder size={14} className="text-sky-300" />)
        : <span className="text-[10px] uppercase tracking-wide text-slate-500">{STAGE_LABELS[node.stage]}</span>}
      <span className="font-medium text-slate-200">{node.name || node.id}</span>
    </div>
  );
}

function EndDropZone({ id }: { id: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} className={`h-2 rounded transition-colors ${isOver ? 'bg-[var(--leaf)]/40' : ''}`} />;
}

function AddRow({ onAdd, compact }: { onAdd: (kind: AddKind) => void; compact?: boolean }) {
  const [kind, setKind] = useState<AddKind>('release');
  return (
    <div className={`flex items-center gap-2 pt-1 ${compact ? '' : 'pl-11'}`}>
      <select className={`${field} w-auto`} value={kind} onChange={(e) => setKind(e.target.value as AddKind)}>
        <optgroup label="Stage">
          {WORKFLOW_STAGE_TYPES.map((t) => <option key={t} value={t}>{STAGE_LABELS[t]}</option>)}
        </optgroup>
        <optgroup label="Container">
          <option value="group">Group</option>
          <option value="loop">Loop</option>
        </optgroup>
      </select>
      <button
        type="button"
        onClick={() => onAdd(kind)}
        className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer"
      >
        <Plus size={13} /> Add stage
      </button>
    </div>
  );
}

interface LevelProps {
  scope: string;
  nodes: WorkflowStageNode[];
  parentId: string | null;
  tree: WorkflowStageNode[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
  onAddAt: (parentId: string | null, kind: AddKind) => void;
}

function NodeLevel({ scope, nodes, parentId, tree, openId, setOpenId, onPatch, onRemove, onAddAt }: LevelProps) {
  const ids = nodes.map((n) => n.id);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <div>
        {nodes.map((n, i) => (
          <SortableNode
            key={n.id}
            scope={scope}
            node={n}
            isLast={i === nodes.length - 1}
            prevSiblingId={nodes[i - 1]?.id}
            tree={tree}
            openId={openId}
            setOpenId={setOpenId}
            onPatch={onPatch}
            onRemove={onRemove}
            onAddAt={onAddAt}
          />
        ))}
      </div>
      <EndDropZone id={endZoneId(scope, parentId)} />
    </SortableContext>
  );
}

function SortableNode({ scope, node, isLast, prevSiblingId, tree, openId, setOpenId, onPatch, onRemove, onAddAt }: {
  scope: string;
  node: WorkflowStageNode;
  isLast: boolean;
  prevSiblingId: string | undefined;
  tree: WorkflowStageNode[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
  onAddAt: (parentId: string | null, kind: AddKind) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  const isOpen = openId === node.id;
  const isContainer = isWorkflowContainerNode(node);
  const runIfRef = typeof node.runIf === 'string' ? node.runIf : undefined;
  const isConditional = node.runIf !== undefined;
  const branchesBack = isConditional && runIfRef !== undefined && runIfRef !== prevSiblingId;
  const runIfTarget = runIfRef ? findNode(tree, runIfRef) : undefined;
  const earlierNodes = nodesBefore(tree, node.id);

  return (
    <div ref={setNodeRef} style={style} className="flex gap-3 items-stretch">
      <div className="flex flex-col items-center w-8 shrink-0">
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 border-2 ${
            node.optional
              ? 'border-dashed border-amber-500/60 text-amber-400 bg-[var(--bark-900)]'
              : isConditional
                ? 'border-solid border-purple-500/60 text-purple-300 bg-[var(--bark-900)]'
                : isContainer
                  ? 'border-solid border-sky-500/60 text-sky-300 bg-[var(--bark-900)]'
                  : 'border-solid border-emerald-500/60 text-emerald-300 bg-[var(--bark-900)]'
          }`}
          title={
            node.optional
              ? 'Optional — a thrown error is reported but does not block the sequence'
              : isConditional
                ? (runIfRef ? `Runs only if "${runIfTarget?.name ?? runIfRef}" ran ok` : 'Runs only under a custom condition')
                : undefined
          }
        >
          {isContainer
            ? (node.containerType === 'loop' ? <Repeat size={12} /> : <Folder size={12} />)
            : <GripVertical size={12} className="opacity-0" />}
        </div>
        {!isLast && <div className={`flex-1 w-px my-0.5 ${branchesBack ? 'bg-purple-500/30' : 'bg-[var(--bark-600)]'}`} />}
      </div>

      <div className="flex-1 min-w-0 pb-3">
        {branchesBack && (
          <div className="flex items-center gap-1 text-[10px] text-purple-300 mb-1">
            <CornerDownRight size={11} />
            <span>runs only if <strong>{runIfTarget?.name ?? runIfRef}</strong> ran ok</span>
          </div>
        )}
        <div className={card}>
          <div className="w-full flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              {...attributes}
              {...listeners}
              title="Drag to reorder or move"
              className="p-1 -ml-1 text-slate-600 hover:text-slate-300 cursor-grab active:cursor-grabbing touch-none"
            >
              <GripVertical size={14} />
            </button>
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : node.id)}
              className="flex-1 flex items-center gap-2 text-left min-w-0"
            >
              {isOpen ? <ChevronDown size={14} className="text-slate-500 shrink-0" /> : <ChevronRight size={14} className="text-slate-500 shrink-0" />}
              <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">
                {isContainer ? (node.containerType === 'loop' ? LOOP_TYPE_LABELS[node.loopType] : 'Group') : STAGE_LABELS[node.stage]}
              </span>
              <span className="font-medium text-slate-200 truncate">{node.name || node.id}</span>
              {node.optional && <span className="text-[10px] text-amber-400 shrink-0">optional</span>}
              {!isContainer && !!node.retries && (
                <span className="flex items-center gap-0.5 text-[10px] text-slate-500 shrink-0">
                  <RefreshCw size={10} /> ×{node.retries + 1}
                </span>
              )}
              {isContainer && node.containerType === 'loop' && (node.loopType === 'count' || node.loopType === 'until') && (
                <span className="text-[10px] text-slate-500 shrink-0">×{node.maxIterations ?? '?'}</span>
              )}
              {isContainer && (
                <span className="text-[10px] text-slate-600 shrink-0">
                  {node.children.length} stage{node.children.length === 1 ? '' : 's'}
                </span>
              )}
            </button>
            <button type="button" title="Remove" onClick={() => onRemove(node.id)} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer">
              <Trash2 size={14} />
            </button>
          </div>

          {isContainer && !isOpen && (
            <div className="px-3 pb-2">
              <EndDropZone id={endZoneId(scope, node.id)} />
            </div>
          )}

          {isOpen && (
            <div className="px-3 pb-3 border-t border-[var(--bark-700)] pt-3">
              {isContainer ? (
                <GroupLoopEditor
                  node={node}
                  earlierNodes={earlierNodes}
                  onChange={(patch: GroupLoopPatch) => onPatch(node.id, patch as Record<string, unknown>)}
                />
              ) : (
                <StageEditor stage={node} earlierNodes={earlierNodes} onChange={(patch) => onPatch(node.id, patch)} />
              )}

              {isContainer && (
                <div className="mt-3 pt-3 border-t border-[var(--bark-700)]">
                  {node.children.length === 0 && (
                    <p className="text-[11px] text-slate-500 italic mb-2">No stages in this {node.containerType} yet.</p>
                  )}
                  <NodeLevel
                    scope={scope} nodes={node.children} parentId={node.id} tree={tree}
                    openId={openId} setOpenId={setOpenId}
                    onPatch={onPatch} onRemove={onRemove} onAddAt={onAddAt}
                  />
                  <AddRow onAdd={(kind) => onAddAt(node.id, kind)} compact />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default NodeList;
