import type { StoryDrop } from '../../leaf-types'

const SAID: Record<StoryDrop['state'], string> = {
  merged: 'merged into its checkout',
  waiting: 'waiting for its checkout to be made',
  conflict: 'not merged: it conflicts with the story\'s own changes',
}

export function StoryDrops({ drops }: { drops: readonly StoryDrop[] }) {
  if (!drops.length) return null
  return (
    <ul className="mt-1 space-y-0.5 text-[11px]" data-testid="story-drops">
      {[...drops].reverse().map((drop) => (
        <li key={drop.id} className={drop.state === 'conflict' ? 'text-amber-200' : drop.state === 'merged' ? 'text-slate-300' : 'text-sky-300'}>
          <span className="font-mono">{drop.paths.length === 1 ? drop.paths[0] : `${drop.paths.length} files`}</span> {SAID[drop.state]}
          {drop.conflicts?.length ? ` (${drop.conflicts.join(', ')})` : ''}
          <span className="text-slate-500"> · {new Date(drop.at).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  )
}
