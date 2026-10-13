import { ArrowDown, ArrowUp } from 'lucide-react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { BOARD_COLUMNS, STATE_HINT } from '../../leaf-types'
import { SortableStoryCard, StoryCard } from './StoryCard'
import { featureOrderAfterMove, storyOrderAfterMove, type Epic, type Feature } from './board'

export function Swimlanes({ epic, selectedLeafId, selectedFeatureId, onOpenLeaf, onOpenFeature, onOrderStories, onOrderFeatures }: {
  epic: Epic
  selectedLeafId?: string | undefined
  selectedFeatureId?: string | undefined
  onOpenLeaf: (leafId: string) => void
  onOpenFeature: (branchId: string) => void
  onOrderStories?: ((branchId: string, order: string[]) => void) | undefined
  onOrderFeatures?: ((order: string[]) => void) | undefined
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  if (epic.features.length === 0) {
    return <p className="px-1 py-3 text-[12px] text-slate-500">No features yet. They appear once a plan for this tree is approved.</p>
  }

  const dropped = (feature: Feature) => (event: DragEndEvent) => {
    if (!event.over || !onOrderStories) return
    const order = storyOrderAfterMove(feature, String(event.active.id), String(event.over.id))
    if (order) onOrderStories(feature.id, order)
  }
  const moveFeature = (featureId: string, by: -1 | 1) => {
    const order = featureOrderAfterMove(epic, featureId, by)
    if (order && onOrderFeatures) onOrderFeatures(order)
  }
  const movable = Boolean(onOrderFeatures) && epic.features.length > 1

  return (
    <div className="overflow-x-auto pb-2">
      <table className="w-full border-separate border-spacing-x-1.5 border-spacing-y-0 table-fixed" style={{ minWidth: `${8 + BOARD_COLUMNS.reduce((sum, column) => sum + (epic.totals[column.id] > 0 ? 10 : 5), 0)}rem` }}>
        <colgroup>
          <col className="w-32" />
          {BOARD_COLUMNS.map((column) => (
            <col key={column.id} style={epic.totals[column.id] > 0 ? undefined : { width: '5rem' }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-1 py-1">Feature</th>
            {BOARD_COLUMNS.map((column) => (
              <th key={column.id} scope="col" title={STATE_HINT[column.id]} className="text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-1 py-1">
                {column.label} <span className="font-mono text-slate-600">{epic.totals[column.id]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {epic.features.map((feature, index) => (
            <tr key={feature.id} data-testid="feature-lane">
              <th scope="row" className="align-top text-left text-[12px] font-medium text-slate-300 px-1 py-2 border-t border-[var(--bark-700)] break-words">
                <button
                  type="button"
                  onClick={() => onOpenFeature(feature.id)}
                  aria-pressed={feature.id === selectedFeatureId}
                  className={`text-left hover:underline cursor-pointer break-words ${feature.id === selectedFeatureId ? 'text-emerald-300' : ''}`}
                  title="Open this feature and its chat"
                >
                  {feature.title}
                </button>
                {movable && (
                  <span className="mt-1 flex gap-0.5">
                    <button type="button" onClick={() => moveFeature(feature.id, -1)} disabled={index === 0} aria-label={`Move “${feature.title}” up`} title="Worked before the feature above" className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default">
                      <ArrowUp size={11} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => moveFeature(feature.id, 1)} disabled={index === epic.features.length - 1} aria-label={`Move “${feature.title}” down`} title="Worked after the feature below" className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default">
                      <ArrowDown size={11} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </th>
              {BOARD_COLUMNS.map((column) => {
                const stories = feature.columns[column.id]
                return (
                  <td key={column.id} className="align-top px-0 py-2 border-t border-[var(--bark-700)]">
                    {onOrderStories && stories.length > 1 ? (
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dropped(feature)}>
                        <SortableContext items={stories.map((story) => story.leaf.id)} strategy={verticalListSortingStrategy}>
                          <div className="space-y-1.5">
                            {stories.map((story) => (
                              <SortableStoryCard key={story.leaf.id} story={story} selected={story.leaf.id === selectedLeafId} onOpen={() => onOpenLeaf(story.leaf.id)} />
                            ))}
                          </div>
                        </SortableContext>
                      </DndContext>
                    ) : (
                      <div className="space-y-1.5">
                        {stories.map((story) => (
                          <StoryCard key={story.leaf.id} story={story} selected={story.leaf.id === selectedLeafId} onOpen={() => onOpenLeaf(story.leaf.id)} />
                        ))}
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default Swimlanes
