import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Boxes, CheckSquare, GripVertical, Hand, Link2, ListPlus, RotateCcw, Rocket, Eye } from 'lucide-react'
import { STATE_DOT } from '../../lib/leaf-types'
import { ago } from '../../lib/home-summary'
import type { Story } from './board'

export function SortableStoryCard({ story, selected, onOpen }: { story: Story; selected: boolean; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: story.leaf.id })
  const grip = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`Move “${story.leaf.title}”`}
      title="Drag to change the order it is worked in"
      className="shrink-0 px-0.5 text-slate-600 hover:text-slate-300 cursor-grab active:cursor-grabbing touch-none"
    >
      <GripVertical size={12} aria-hidden="true" />
    </button>
  )
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={isDragging ? 'relative z-10 opacity-80' : undefined}>
      <StoryCard story={story} selected={selected} onOpen={onOpen} grip={grip} />
    </div>
  )
}

export function StoryCard({ story, selected, onOpen, grip }: { story: Story; selected: boolean; onOpen: () => void; grip?: ReactNode | undefined }) {
  const { leaf } = story
  return (
    <div
      className={`flex items-stretch rounded-md border transition-colors ${selected ? 'border-emerald-500/60 bg-emerald-950/40' : 'border-[var(--bark-600)] bg-[var(--bark-800)] hover:border-[var(--bark-500,#3a4a41)]'}`}
      data-testid="story-card"
    >
      {grip}
      <button
        type="button"
        onClick={onOpen}
        aria-pressed={selected}
        className={`flex-1 min-w-0 text-left py-1.5 pr-2 space-y-1 cursor-pointer ${grip ? 'pl-0.5' : 'pl-2'}`}
      >
        <span className="flex items-start gap-1.5">
          <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[story.state]}`} aria-hidden="true" />
          <span className="text-[12px] text-slate-200 leading-snug break-words">{leaf.title}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
          {story.asks && (
            <span className="flex items-center gap-0.5 text-amber-300" title={`${story.asks.agent ?? 'Its run'} waits for you to allow ${story.asks.tool}`} data-testid="story-asks"><Hand size={10} aria-hidden="true" /> waits for you to allow {story.asks.tool}</span>
          )}
          {story.tasks.total > 0 && (
            <span className="flex items-center gap-0.5" title="Tasks done"><CheckSquare size={10} aria-hidden="true" /> {story.tasks.done}/{story.tasks.total}</span>
          )}
          {story.tasks.proposed > 0 && (
            <span className="flex items-center gap-0.5 text-sky-300" title="Tasks proposed for this story, waiting for you on its page"><ListPlus size={10} aria-hidden="true" /> {story.tasks.proposed} proposed</span>
          )}
          {story.waitsOn.length > 0 && (
            <span className="flex items-center gap-0.5 text-amber-300/80" title={`Waits on ${story.waitsOn.join(', ')}`}><Link2 size={10} aria-hidden="true" /> waits on {story.waitsOn.length}</span>
          )}
          {story.waitsForWorkspace && (
            story.workspaceStuck
              ? <span className="flex items-center gap-0.5 text-red-300/80" title={`Its workspace is ${story.workspaceStuck}`}><Boxes size={10} aria-hidden="true" /> its workspace did not build</span>
              : <span className="flex items-center gap-0.5 text-amber-300/80" title={story.waitsForWorkspace}><Boxes size={10} aria-hidden="true" /> waits on its workspace</span>
          )}
          {story.attempts > 0 && (
            <span className="flex items-center gap-0.5 text-amber-400/80"><RotateCcw size={10} aria-hidden="true" /> retried {story.attempts}×</span>
          )}
          {story.reached === 'live' && <span className="flex items-center gap-0.5 text-emerald-300"><Rocket size={10} aria-hidden="true" /> live</span>}
          {story.reached === 'preview' && <span className="flex items-center gap-0.5 text-amber-300"><Eye size={10} aria-hidden="true" /> in preview</span>}
          <span className="ml-auto">{ago(leaf.updatedAt)}</span>
        </span>
      </button>
    </div>
  )
}

export default StoryCard
