import { User, Sparkles, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { memo, useState } from 'react';
import Markdown from '../Markdown.js';
import { KoalaSpot, type KoalaMood } from '../Koala.js';
import ChatToolCallCard, { type ToolCallData } from './ChatToolCallCard.js';
import { ChatParser } from '../../lib/chat-parser/chat-parser.js';

export interface ChatMessageData {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | undefined;
  at?: string | undefined;
  toolCalls?: ToolCallData[] | undefined;
  interruptedReason?: string | undefined;
}

export function ThinkingDisclosure({
  thoughts,
  isThinking = false,
  defaultOpen = true,
}: {
  thoughts: string[];
  isThinking?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (thoughts.length === 0 && !isThinking) return null;

  return (
    <div className="my-2 rounded-md border border-[var(--bark-800,#1b2620)] bg-[var(--bark-900,#111814)]/40 overflow-hidden text-xs font-sans">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-slate-300 hover:text-slate-100 hover:bg-[var(--bark-900,#111814)] transition-colors select-none text-xs cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {isThinking ? (
            <Sparkles size={13} className="text-amber-400 animate-spin" />
          ) : (
            <Sparkles size={13} className="text-emerald-400" />
          )}
          <span className="font-medium text-slate-300">
            {isThinking ? 'Thinking & Analyzing...' : 'Thought Process & Analysis'}
          </span>
        </div>
        <div className="flex items-center gap-1 text-slate-500 text-[11px]">
          <span>{open ? 'Hide' : 'Show'}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>
      </button>

      {open && (
        <div className="px-3 py-2 border-t border-[var(--bark-800,#1b2620)] bg-black/20 text-slate-300 space-y-1.5 text-xs leading-relaxed font-sans whitespace-pre-wrap max-h-56 overflow-y-auto">
          {thoughts.map((thought, idx) => (
            <div key={idx} className="border-l border-emerald-500/50 pl-2.5 py-0.5 text-slate-300">
              {thought}
            </div>
          ))}
          {isThinking && (
            <div className="flex items-center gap-1.5 text-amber-400/90 italic pt-0.5 text-[11px]">
              <span>Formulating response and verifying execution plan...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  packLabel = 'Koala',
  isStreaming = false,
}: {
  message: ChatMessageData;
  packLabel?: string;
  isStreaming?: boolean;
}) {
  const isUser = message.role === 'user';
  const mascotMood: KoalaMood = isStreaming ? 'thinking' : 'idle';

  const parsed = ChatParser.parse(message.content ?? '');
  const allThoughts = [
    ...(message.reasoning ? [message.reasoning.trim()] : []),
    ...parsed.thoughts,
  ].filter(Boolean);

  const allToolCalls: ToolCallData[] = [
    ...(message.toolCalls ?? []),
    ...parsed.toolCalls.map((pt, i) => ({
      id: `parsed-tool-${i}`,
      name: pt.name,
      args: pt.args,
      ok: true,
    })),
  ];

  const isThinkingNow = Boolean(
    isStreaming && (
      parsed.isThinking ||
      (Boolean(message.reasoning) && !parsed.cleanContent) ||
      (!parsed.cleanContent && allToolCalls.length === 0)
    )
  );

  return (
    <div
      className={`py-4 border-b border-[var(--bark-800,#1b2620)]/50 flex gap-3.5 items-start w-full group font-sans ${
        isUser ? 'bg-[var(--bark-900,#111814)]/20' : ''
      }`}
    >
      <div className="shrink-0 w-7 h-7 rounded-md bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] flex items-center justify-center shadow-xs mt-0.5">
        {isUser ? (
          <User size={14} className="text-emerald-400" />
        ) : (
          <KoalaSpot size={20} mood={mascotMood} />
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-slate-400 font-sans">
          <span className={`font-semibold ${isUser ? 'text-slate-200' : 'text-emerald-400'}`}>
            {isUser ? 'You' : packLabel}
          </span>
          {message.at && (
            <span className="text-slate-500 text-[11px]">
              {new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {(allThoughts.length > 0 || isThinkingNow) && (
          <ThinkingDisclosure
            thoughts={allThoughts}
            isThinking={isThinkingNow}
            defaultOpen={true}
          />
        )}

        {allToolCalls.length > 0 && (
          <div className="space-y-1 my-2">
            {allToolCalls.map((t) => (
              <ChatToolCallCard key={t.id} tool={t} />
            ))}
          </div>
        )}

        <div className="text-[13.5px] leading-relaxed text-slate-200 prose prose-invert max-w-none">
          {parsed.cleanContent ? (
            <Markdown>{parsed.cleanContent}</Markdown>
          ) : isThinkingNow || allThoughts.length > 0 ? null : (
            <span className="italic text-slate-500 text-xs">[No textual response]</span>
          )}
        </div>

        {message.interruptedReason && (
          <div className="mt-2 text-xs text-amber-400 bg-amber-950/40 border border-amber-800/60 rounded-lg px-3 py-2 flex items-center gap-2 select-none">
            <AlertTriangle size={14} className="shrink-0 text-amber-400" />
            <span><strong>Interrupted:</strong> {message.interruptedReason}</span>
          </div>
        )}
      </div>
    </div>
  );
});

export default ChatMessageRow;
