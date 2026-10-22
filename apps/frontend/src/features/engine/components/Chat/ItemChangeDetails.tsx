import { useState } from 'react'
import type { ItemChange } from '@koala/harness-types'
import { editRows, storyName } from '../../../projects'

export function ItemChangeDetails({ change, decided }: { change: ItemChange; decided: boolean }) {
  const [showBrief, setShowBrief] = useState(false)
  const rows = editRows(change)

  return (
    <div className="flex flex-col gap-2" data-testid="item-change">
      <div className="text-slate-300"><span className="text-slate-500">Why: </span>{change.why}</div>

      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {rows.map((row, index) => (
            <div key={`${row.label}-${index}`} className="contents">
              <dt className="text-slate-500">{row.label}</dt>
              <dd className="min-w-0 break-words">
                {row.before !== undefined && <div className="text-slate-500 line-through decoration-slate-600">{row.before || 'nothing'}</div>}
                <div className="text-slate-200">{row.after}</div>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {change.edit?.brief && (
        <>
          <button type="button" onClick={() => setShowBrief((open) => !open)} className="self-start text-slate-400 hover:text-slate-200 underline cursor-pointer">
            {showBrief ? 'Hide the new brief' : 'Read the new brief'}
          </button>
          {showBrief && <pre className="whitespace-pre-wrap font-sans text-slate-300 bg-[var(--bark-900)]/60 rounded p-2 max-h-72 overflow-y-auto">{change.edit.brief}</pre>}
        </>
      )}

      {change.add && (
        <ul className="flex flex-col gap-1">
          {change.add.leaves.map((leaf) => (
            <li key={leaf.key}>
              <span className="text-slate-200">{leaf.title}</span>
              <span className="text-slate-500"> — {leaf.body}</span>
              {leaf.dependsOn.length > 0 && (
                <span className="text-slate-500"> (after {leaf.dependsOn.map((id) => change.add!.leaves.find((other) => other.key === id)?.title ?? storyName(change, id)).join(', ')})</span>
              )}
              {leaf.tasks.length > 0 ? (
                <ul className="ml-3 text-slate-400 list-disc list-inside">
                  {leaf.tasks.map((task) => <li key={task.key}>{task.title} <span className="text-slate-500">— done means: {task.doneMeans}</span></li>)}
                </ul>
              ) : (
                <div className="ml-3 text-slate-500">No tasks yet — the planner breaks it down first.</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {change.cancel && (
        <ul className="ml-3 list-disc list-inside text-slate-300">
          {change.cancel.map((id) => <li key={id}>{storyName(change, id)}</li>)}
        </ul>
      )}

      {!decided && change.outcome.length > 0 && (
        <div>
          <div className="text-slate-500">Approving:</div>
          <ul className="ml-3 list-disc list-inside text-slate-300">
            {change.outcome.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

export default ItemChangeDetails
