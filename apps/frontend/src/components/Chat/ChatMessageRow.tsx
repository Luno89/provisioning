import { User, Sparkles, Sprout, ChevronDown, ChevronRight, Info, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import Markdown from '../Markdown.js';
import { KoalaSpot, type KoalaMood } from '../Koala.js';
import ChatToolCallCard, { type ToolCallData } from './ChatToolCallCard.js';
import { ChatParser } from '../../lib/chat-parser/chat-parser.js';

export interface ChatMessageData {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | undefined;
  at?: string | undefined;
  enabled?: string[] | undefined;
  toolCalls?: ToolCallData[] | undefined;
  /** A system event (auto-accept, a duplicate warning, …) — rendered as one, not as the assistant speaking. */
  notice?: boolean | undefined;
  interruptedReason?: string | undefined;
}

export interface ProposedTreeData {
  id: string;
  name: string;
  type: string;
  goal?: string | undefined;
  treeId?: string | undefined;
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

export function ProposedTreeCard({
  proposal,
  onAccept,
  isPending = false,
}: {
  proposal: ProposedTreeData;
  onAccept: (id: string) => void;
  isPending?: boolean;
}) {
  return (
    <div className="my-2 p-3 rounded-lg border border-amber-500/40 bg-[var(--bark-900,#111814)] text-xs space-y-1.5 font-sans">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-amber-500/10 text-amber-400">
            <Sprout size={14} />
          </div>
          <div>
            <div className="font-semibold text-slate-100">{proposal.name}</div>
            <div className="text-[11px] text-slate-400">
              Type: <span className="text-slate-300">{proposal.type}</span>
            </div>
          </div>
        </div>

        {proposal.treeId ? (
          <a
            href={`#/grove/${proposal.treeId}`}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/50 text-emerald-300 text-xs font-medium transition-all cursor-pointer"
          >
            <Sprout size={12} />
            <span>Open in Grove</span>
          </a>
        ) : (
          <button
            type="button"
            onClick={() => onAccept(proposal.id)}
            disabled={isPending}
            className="px-3 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-all cursor-pointer disabled:opacity-50"
          >
            {isPending ? 'Branching...' : 'Accept to Grove'}
          </button>
        )}
      </div>

      {proposal.goal && (
        <p className="text-xs text-slate-400 leading-relaxed font-sans pt-0.5">
          {proposal.goal}
        </p>
      )}
    </div>
  );
}

export function ChatMessageRow({
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

  if (message.notice) {
    return (
      <div className="flex gap-3 py-2">
        <div className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-600">
          <Info size={15} />
        </div>
        <div className="flex-1 pt-1 min-w-0 text-[12px] text-slate-400 leading-relaxed border-l-2 border-[var(--bark-600)] pl-3 py-1">
          <Markdown>{message.content}</Markdown>
        </div>
      </div>
    );
  }

  const parsed = ChatParser.parse(message.content ?? '');
  const allThoughts = [
    ...(message.reasoning ? [message.reasoning.trim()] : []),
    ...parsed.thoughts,
  ].filter(Boolean);

  const isThinkingNow = Boolean(
    (isStreaming && parsed.isThinking) ||
    (isStreaming && message.reasoning && !parsed.cleanContent)
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

        {message.enabled && message.enabled.length > 0 && (
          <div className="my-1.5 flex flex-wrap gap-1.5 items-center text-xs text-slate-300 font-sans">
            <span className="text-slate-400 font-medium">Services attached:</span>
            {message.enabled.map((name, i) => (
              <span key={i} className="px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono">
                {name}
              </span>
            ))}
          </div>
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1 my-2">
            {message.toolCalls.map((t) => (
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
}

export default ChatMessageRow;
