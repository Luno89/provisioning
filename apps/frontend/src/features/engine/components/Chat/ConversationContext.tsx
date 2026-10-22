import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import Markdown from '../../../../shared/components/Markdown'
import { chatPackKeys, getConversationContext } from '../../api/chat-pack'
import { ID_INPUTS, INPUT_TITLES, outlineMarkdown, subjectOf } from '../../lib/outline-markdown'

export function ConversationContext({ conversationId, channel = false }: { conversationId: string; channel?: boolean | undefined }) {
  const context = useQuery({ queryKey: chatPackKeys.context(conversationId), queryFn: () => getConversationContext(conversationId), refetchInterval: 10_000 })
  const [exact, setExact] = useState(false)
  if (!context.data?.text) return null
  const { given, text } = context.data
  const ids = Object.entries(given).filter(([name]) => ID_INPUTS.has(name))
  const parts = Object.entries(given).filter(([name]) => !ID_INPUTS.has(name))
  return (
    <details open className="my-3 rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] text-left group" data-testid="conversation-context">
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-[12px] text-slate-300">
        <Eye size={13} className="text-emerald-300 shrink-0" aria-hidden="true" />
        <span className="flex-1">What Koala sees about this {subjectOf(given)}, added to every message you send here{channel ? ' that goes to Koala' : ''}</span>
        <span className="text-[10px] text-slate-500 group-open:hidden">show</span>
      </summary>
      <div className="px-3 pb-3 space-y-2">
        {exact ? (
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[var(--bark-950,#090d0b)] p-2 font-mono text-[11px] leading-relaxed text-slate-300" data-testid="context-exact">{text}</pre>
        ) : (
          <div className="max-h-96 overflow-y-auto overflow-x-hidden space-y-2 pr-1">
            {parts.map(([name, value]) => (
              <section key={name} aria-label={INPUT_TITLES[name] ?? name}>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{INPUT_TITLES[name] ?? name}</h3>
                <Markdown className="text-[12px] text-slate-300 [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal">{outlineMarkdown(value)}</Markdown>
              </section>
            ))}
            {ids.length > 0 && (
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                {ids.map(([name, value]) => <span key={name}>{name} <code className="font-mono text-slate-400">{value}</code></span>)}
              </p>
            )}
          </div>
        )}
        <div className="flex items-center gap-3 text-[10px] text-slate-500">
          <span className="flex-1">Read again on every message, so it is always as things are now.</span>
          <button type="button" onClick={() => setExact((now) => !now)} className="text-emerald-300 hover:underline cursor-pointer">
            {exact ? 'Show it formatted' : 'Show exactly as sent'}
          </button>
        </div>
      </div>
    </details>
  )
}

export default ConversationContext
