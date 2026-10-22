import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowRight, Hand, StickyNote } from 'lucide-react'
import { cardLine, isWaiting, type ChatCard } from './chat-cards'

export interface CardFocus {
  id: string
  n: number
}

export interface ChatCardsProps {
  cards: readonly ChatCard[]
  focus?: CardFocus | undefined
  render: (card: ChatCard) => ReactNode
}

export function ChatCards({ cards, focus, render }: ChatCardsProps) {
  const placed = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    if (focus) placed.current.get(focus.id)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [focus])

  const waiting = cards.filter(isWaiting)
  const settled = cards.filter((card) => !isWaiting(card))
  const place = (card: ChatCard) => (
    <div
      key={`${card.kind} ${card.id}`}
      ref={(element) => { if (element) placed.current.set(card.id, element); else placed.current.delete(card.id) }}
      data-testid="chat-card"
      data-focused={focus?.id === card.id ? 'true' : undefined}
      className={`rounded-md ${focus?.id === card.id ? 'ring-1 ring-emerald-500/70' : ''}`}
    >
      {render(card)}
    </div>
  )

  return (
    <div className="h-full min-h-0 overflow-y-auto px-3 py-2 space-y-3" data-testid="chat-cards">
      {waiting.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-amber-300/90 px-1 pt-1">
            <Hand size={12} /> Waiting for you
          </h3>
          {waiting.map(place)}
        </section>
      )}
      {settled.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500 px-1 pt-1">
            <StickyNote size={12} /> Earlier
          </h3>
          {settled.map(place)}
        </section>
      )}
    </div>
  )
}

export function ChatCardMarker({ card, onShow }: { card: ChatCard; onShow: (id: string) => void }) {
  const waiting = isWaiting(card)
  return (
    <button
      type="button"
      onClick={() => onShow(card.id)}
      data-testid="chat-card-marker"
      className={`group my-1 flex max-w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] cursor-pointer border ${waiting ? 'border-amber-500/40 bg-amber-950/30 text-amber-200 hover:bg-amber-900/40' : 'border-[var(--bark-800,#1b2620)] text-slate-400 hover:text-slate-200'}`}
    >
      {waiting ? <Hand size={12} className="shrink-0" /> : <StickyNote size={12} className="shrink-0" />}
      <span className="truncate">{cardLine(card)}</span>
      <ArrowRight size={12} className="shrink-0 opacity-60 group-hover:opacity-100" />
    </button>
  )
}
