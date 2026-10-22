import type { ToolNote } from '../api'
import { errorMessage } from '../../../api/client'
import { panelClass, primaryButton, quietButton, useDecideToolNote, useToolNotes } from '../shared'
import { noteAbout, noteTrial, notesIn, type NoteScope } from '../lib/tool-notes'

const GROUPS: { status: NonNullable<ToolNote['status']>; title: string; says: string }[] = [
  { status: 'pending_review', title: 'Held for you', says: 'When the bench tried these, no check that failed before passed, or something got worse, so they wait for you.' },
  { status: 'trial', title: 'On trial', says: 'The bench tries these on the checks that use the tool at the next idle moment. One goes live only if it makes a failing check pass and nothing gets worse.' },
  { status: 'active', title: 'Live', says: 'These are shown beside the tool to every agent offered it.' },
]

export default function ToolNotesPanel({ scope }: { scope: NoteScope }) {
  const notes = useToolNotes()
  const { live, retire } = useDecideToolNote()
  const mine = notesIn(notes.data ?? [], scope)
  const error = live.error ?? retire.error ?? notes.error

  return (
    <section className={`flex flex-col gap-3 ${panelClass}`}>
      <p className="text-xs text-slate-500">Notes the memory keeper learned from runs about using {'server' in scope ? `${scope.server}'s tools` : 'this tool'}. Each one is tried on the bench first and goes live only if it makes a check pass that failed before, and nothing gets worse. One kept for a model is shown only on that model, and is tried on it.</p>
      {error && <p className="text-xs text-rose-300">{errorMessage(error)}</p>}
      {notes.isSuccess && mine.length === 0 && <p className="text-sm text-slate-400">Nothing learned yet.</p>}
      {GROUPS.map((group) => {
        const members = mine.filter((note) => (note.status ?? 'active') === group.status)
        if (members.length === 0) return null
        return (
          <div key={group.status} className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-slate-300">{group.title} ({members.length})</h4>
            <p className="text-[11px] text-slate-500">{group.says}</p>
            <ul className="flex flex-col gap-2">
              {members.map((note) => (
                <li key={note.id} className="rounded border border-[var(--bark-700)] p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold text-slate-200">{note.title}</span>
                    <span className="text-xs text-slate-500">on {noteAbout(note)}{note.model ? `, only for ${note.model}` : ''}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-slate-300">{note.text}</p>
                  {note.why && <p className="mt-1 text-xs text-slate-500">Learned from: {note.why}</p>}
                  {note.trial && <p className="mt-1 text-xs text-slate-400">Trial: {noteTrial(note)}</p>}
                  {note.status === 'trial' && note.model && <p className="mt-1 text-xs text-slate-400">The bench tries it on {note.model}, at an idle moment while one of your endpoints serves it.</p>}
                  <div className="mt-2 flex gap-2">
                    {note.status !== 'active' && (
                      <button type="button" disabled={live.isPending} onClick={() => live.mutate(note.id)} className={primaryButton}>Make live</button>
                    )}
                    <button type="button" disabled={retire.isPending} onClick={() => retire.mutate(note.id)} className={quietButton}>Retire</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
