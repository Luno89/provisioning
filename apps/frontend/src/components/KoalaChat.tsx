import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquarePlus, Trash2, Plug, Sprout, Send, Loader2, Terminal, Check, X, Info,
} from 'lucide-react';
import SpecProposal from './SpecProposal.js';
import Markdown from './Markdown.js';
import {
  listConversations, getConversation, createConversation, deleteConversation,
  acceptSpecProposal, acceptTreeProposal, openKoalaStream, koalaKeys,
} from '../api/koala';
import { errorMessage } from '../api/client';

/**
 * General chat with Koala — the front door when you have not decided what you are building.
 *
 * ── WHY THIS IS NOT THE GROVE ──
 * A branch is a conversation about building one thing, and everything it produces is work someone
 * accepts and runs. Asking "what is going on with the MCP server" should not require choosing a tree
 * first, nor leave a branch behind. So this is a normal chat with named threads, and what it
 * produces is a PROPOSED PROJECT that the Grove then builds.
 *
 * ── THE SESSION ──
 * `sessionId` is generated once per mount and sent with every turn. Services Koala hooks up belong
 * to it, so they reset when you come back tomorrow rather than riding on every message forever.
 */

interface ProposedTree {
  id: string;
  name: string;
  type: string;
  goal: string;
  treeId?: string;
}

interface ToolCall {
  id: string;
  name: string;
  args: string;
  ok: boolean;
  digest: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** Deliberation, kept apart from the answer so it can be collapsed. */
  reasoning?: string;
  at: string;
  /** Services hooked up while producing this message — a record, not the model's claim. */
  enabled?: string[];
  /** What the turn actually did. Same principle as `enabled`, extended to every tool. */
  toolCalls?: ToolCall[];
  /** Written by the harness, not the model. Rendered inline rather than as a chat bubble. */
  notice?: true;
  /** This notice is a context-reset boundary; everything above it was summarised into it. */
  handoff?: true;
}

interface ProposedSpec {
  id: string;
  spec: import('./SpecProposal.js').Spec;
  acceptedAt?: string;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  proposedTrees?: ProposedTree[];
  proposedSpecs?: ProposedSpec[];
  updatedAt: string;
}

export default function KoalaChat({ onOpenTree }: {
  /** Handing off to the Grove once a project exists, so accepting is not a dead end. */
  onOpenTree?: (treeId: string) => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState('');
  const [liveThinking, setLiveThinking] = useState('');
  const [liveEnabled, setLiveEnabled] = useState<string[]>([]);
  /** Tool calls in flight this turn. `running` is local UI state — the record is on the message. */
  const [liveTools, setLiveTools] = useState<(ToolCall & { running?: boolean })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** One per mount. What "session" means for the services Koala hooks up. */
  const sessionId = useRef(Math.random().toString(36).slice(2));

  const { data: threads } = useQuery<(Conversation & { messageCount: number })[]>({
    queryKey: koalaKeys.conversations(),
    queryFn: () => listConversations<Conversation & { messageCount: number }>(),
    refetchInterval: 15000,
  });

  const { data: thread } = useQuery<Conversation>({
    queryKey: koalaKeys.conversation(selected ?? ''),
    queryFn: () => getConversation<Conversation>(selected!),
    enabled: Boolean(selected),
  });

  const create = useMutation({
    mutationFn: () => createConversation<Conversation>(),
    onSuccess: (c: Conversation) => { setSelected(c.id); qc.invalidateQueries({ queryKey: ['koala-conversations'] }); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: (_, id) => {
      if (selected === id) setSelected(null);
      qc.invalidateQueries({ queryKey: ['koala-conversations'] });
    },
  });

  const acceptSpec = useMutation({
    mutationFn: (proposalId: string) => acceptSpecProposal(selected!, proposalId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['koala-conversation', selected] });
      // The catalogue changed, so anything showing what can be deployed is now stale.
      qc.invalidateQueries({ queryKey: ['persona-options'] });
    },
    onError: (err: unknown) => setError(errorMessage(err) || 'Could not add that app type.'),
  });

  const accept = useMutation({
    mutationFn: (proposalId: string) =>
      acceptTreeProposal<{ tree?: { id: string } }>(selected!, proposalId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['koala-conversation', selected] });
      qc.invalidateQueries({ queryKey: ['trees'] });
      if (res?.tree?.id) onOpenTree?.(res.tree.id);
    },
  });

  // Follows the newest text while a reply streams in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread?.messages.length, live]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    let id = selected;
    if (!id) {
      const created = await create.mutateAsync();
      id = created.id;
    }
    setInput('');
    setError(null);
    setStreaming(true);
    setLive('');
    setLiveThinking('');
    setLiveEnabled([]);
    setLiveTools([]);
    try {
      const res = await openKoalaStream({
        conversationId: id, message: text, sessionId: sessionId.current,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const frame = JSON.parse(payload);
            if (frame.delta) setLive((prev) => prev + frame.delta);
            // Streamed from the first round, so a turn that spends eighty seconds deciding what to
            // do shows its working rather than a spinner.
            if (frame.reasoning) setLiveThinking((prev) => prev + frame.reasoning);
            // Shown as it happens rather than trusting the model to mention it.
            if (frame.enabled) setLiveEnabled((prev) => [...prev, ...frame.enabled]);
            /**
             * A pill appears BEFORE the call runs and flips when it lands.
             *
             * `get_logs` shells out to kubectl and an MCP call crosses the network; both used to
             * render as "Koala is thinking…" with nothing behind them, so a slow tool was
             * indistinguishable from a stuck app.
             */
            if (frame.toolCall) {
              setLiveTools((prev) => [...prev, { ...frame.toolCall, running: true }]);
            }
            if (frame.toolResult) {
              setLiveTools((prev) => prev.map((t) => (
                t.id === frame.toolResult.id
                  ? { ...t, running: false, ok: frame.toolResult.ok, digest: frame.toolResult.digest }
                  : t
              )));
            }
            // Both refetch the thread rather than being appended locally: the server already wrote
            // them, and a second copy in state is a second source of truth.
            if (frame.proposedTree || frame.proposedSpec) {
              qc.invalidateQueries({ queryKey: ['koala-conversation', id] });
            }
          } catch { /* a partial frame; the next chunk completes it */ }
        }
      }
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Something went wrong');
    } finally {
      setStreaming(false);
      setLive('');
      setLiveThinking('');
      setLiveEnabled([]);
      setLiveTools([]);
      qc.invalidateQueries({ queryKey: ['koala-conversation', id] });
      qc.invalidateQueries({ queryKey: ['koala-conversations'] });
    }
  };

  const proposals = (thread?.proposedTrees ?? []);
  const specs = (thread?.proposedSpecs ?? []);

  return (
    <div className="flex gap-4 h-[calc(100vh-8rem)]">
      <aside className="w-64 shrink-0 flex flex-col gap-2">
        <button
          onClick={() => create.mutate()}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-[var(--leaf-stem)] text-white text-[13px] font-semibold hover:opacity-90"
        >
          <MessageSquarePlus size={15} /> New chat
        </button>
        <div className="flex-1 overflow-y-auto flex flex-col gap-1">
          {(threads ?? []).map((t) => (
            <div
              key={t.id}
              className={`group flex items-center gap-1.5 px-3 py-2 rounded-lg cursor-pointer text-[13px] ${
                selected === t.id ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-800)]'}`}
              onClick={() => setSelected(t.id)}
            >
              <span className="truncate flex-1 min-w-0">{t.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${t.title}"?`)) remove.mutate(t.id); }}
                title="Delete conversation"
                className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {threads?.length === 0 && (
            <p className="text-[12px] text-slate-500 px-3 py-2">
              Nothing yet. Ask Koala anything — it can look at what you have running and work out what to build.
            </p>
          )}
        </div>
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto flex flex-col gap-4 pr-2">
          {(thread?.messages ?? []).map((m, i) => (
            m.notice ? (
              // Not a chat bubble: nobody said this. Same treatment branch notices get.
              <Notice key={i} text={m.content} boundary={Boolean(m.handoff)} />
            ) : (
              <div key={i} className={m.role === 'user' ? 'self-end max-w-[80%]' : 'max-w-[85%]'}>
                {m.enabled?.length ? <EnabledLine names={m.enabled} /> : null}
                {m.reasoning?.trim() ? <Thinking text={m.reasoning} /> : null}
                {m.toolCalls?.length ? <ToolPills calls={m.toolCalls} /> : null}
                <div className={`rounded-2xl px-4 py-2.5 text-[14px] ${
                  m.role === 'user'
                    ? 'bg-[var(--leaf-stem)] text-white whitespace-pre-wrap'
                    : 'bg-[var(--bark-800)] text-slate-200 border border-[var(--bark-600)]'}`}
                >
                  {/**
                    * The user's own text stays literal — they typed it, and markdown-rendering it
                    * would eat their asterisks. Koala's replies are markdown, and were being shown
                    * as their own syntax: tables arrived as rows of pipes, `##` as literal hashes.
                    * Branch chat has rendered them properly for a while; this had not caught up.
                    */}
                  {m.role === 'user' ? m.content : <Markdown>{m.content}</Markdown>}
                </div>
              </div>
            )
          ))}

          {liveEnabled.length > 0 && <EnabledLine names={liveEnabled} />}
          {liveTools.length > 0 && <ToolPills calls={liveTools} />}
          {liveThinking.trim() && <Thinking text={liveThinking} open={!live} live={!live} />}
          {live && (
            <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] bg-[var(--bark-800)] text-slate-200 border border-[var(--bark-600)]">
              {/* Rendered as markdown while streaming too, so the reply does not reflow the moment
                  the turn ends — a half-written table looks better than one that jumps. */}
              <Markdown>{live}</Markdown>
            </div>
          )}
          {streaming && !live && !liveThinking && (
            <div className="flex items-center gap-2 text-[12px] text-slate-500">
              <Loader2 size={13} className="animate-spin" /> Koala is thinking…
            </div>
          )}

          {specs.map((p) => (
            <SpecProposal
              key={p.id}
              spec={p.spec}
              accepted={Boolean(p.acceptedAt)}
              pending={acceptSpec.isPending}
              onAccept={() => acceptSpec.mutate(p.id)}
            />
          ))}

          {proposals.map((p) => (
            <div key={p.id} className="max-w-[85%] rounded-2xl border border-[var(--leaf)]/40 bg-[var(--leaf)]/5 px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <Sprout size={14} className="text-[var(--leaf)]" />
                <span className="text-[13px] font-bold text-slate-100">{p.name}</span>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">{p.type}</span>
              </div>
              <p className="text-[13px] text-slate-300 mb-2">{p.goal}</p>
              {p.treeId ? (
                <button onClick={() => onOpenTree?.(p.treeId!)} className="text-[12px] text-[var(--leaf)] hover:underline">
                  Created — open it in the Grove
                </button>
              ) : (
                <button
                  onClick={() => accept.mutate(p.id)}
                  disabled={accept.isPending}
                  className="px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] text-white text-[12px] font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  Create this project
                </button>
              )}
            </div>
          ))}
        </div>

        {error && <div className="mt-3 text-[13px] text-red-400">{error}</div>}

        <div className="mt-3 flex gap-3 shrink-0">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Ask Koala anything…"
            rows={2}
            className="flex-1 bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl px-4 py-3 text-[14px] text-slate-200 resize-none focus:border-[var(--leaf)] focus:outline-none"
          />
          <button
            onClick={() => void send()}
            disabled={streaming || !input.trim()}
            className="px-4 rounded-xl bg-[var(--leaf-stem)] text-white disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Deliberation, collapsed.
 *
 * Open while it is the only thing there and closed once the answer arrives, so a long think is
 * visible as it happens and out of the way afterwards — the same shape branch chat uses, because
 * it is the same model doing the same kind of work.
 *
 * Blank reasoning is never rendered: `pre-wrap` faithfully preserves newlines, and a disclosure
 * holding nothing but them shows up as a mysterious vertical gap.
 */
function Thinking({ text, open, live }: { text: string; open?: boolean; live?: boolean }) {
  return (
    <details className="mb-1.5 group" open={open}>
      <summary className="text-[11px] uppercase tracking-widest text-slate-500 cursor-pointer select-none">
        Thinking{live ? '…' : ''}
      </summary>
      {/* pre-wrap rather than markdown: deliberation is not written as markdown, and its
          indentation is often the only structure it has. */}
      <div className="mt-1 text-[12px] text-slate-500 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--bark-600)] pl-3">
        {text.trim()}
      </div>
    </details>
  );
}

/**
 * "Hooked up github-mcp" — shown because the model saying so is a claim, and this is the record.
 *
 * A tool appearing mid-conversation is otherwise invisible: the schemas arrive server-side and
 * nothing in the transcript would show that Koala's reach just changed.
 */
function EnabledLine({ names }: { names: string[] }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--leaf)] mb-1">
      <Plug size={11} />
      hooked up {names.join(', ')}
    </div>
  );
}

/**
 * What the turn actually did, one pill per call.
 *
 * ── WHY THIS IS NOT OPTIONAL POLISH ──
 * Koala shells out to kubectl for pod logs, reaches across the network for MCP calls, and now
 * searches the web — and none of it was visible. A turn that spent ninety seconds reading logs
 * looked exactly like a turn that was stuck, and afterwards there was no way to tell whether an
 * answer came from a tool or from the model's imagination. `EnabledLine` already applies this
 * principle to services; this extends it to every call.
 *
 * The pill shows the tool and its arguments, never its output. The digest is on the record and in
 * the title attribute for anyone who wants it, but a transcript that inlines twelve kilobytes of
 * kubectl output is not a transcript.
 */
function ToolPills({ calls }: { calls: (ToolCall & { running?: boolean })[] }) {
  return (
    <div className="flex flex-col gap-1 mb-1.5">
      {calls.map((c) => (
        <div
          key={c.id}
          title={c.digest || undefined}
          className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-black/25 border border-[var(--bark-600)] text-[11px] font-mono text-slate-400 w-fit max-w-full"
        >
          {c.running
            ? <Loader2 size={11} className="animate-spin shrink-0 text-slate-500" />
            : c.ok
              ? <Check size={11} className="shrink-0 text-emerald-400" />
              : <X size={11} className="shrink-0 text-rose-400" />}
          <Terminal size={11} className="shrink-0 text-slate-500" />
          <span className="text-slate-300 font-semibold">{c.name}</span>
          {c.args && c.args !== '{}' && (
            <span className="truncate text-slate-500">{c.args}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A message the harness wrote, not the model.
 *
 * Rendered inline and dimmed rather than as a chat bubble, because attributing it to Koala would be
 * a lie about who said it — the same reason branch notices are drawn this way in Chat.tsx.
 *
 * The handoff variant is collapsed by default. Its whole job is to be reassuring at a glance
 * ("older messages were summarised") while staying auditable for anyone who wants to know exactly
 * what survived the reset, which is the question you ask precisely when something has gone wrong.
 */
function Notice({ text, boundary }: { text: string; boundary: boolean }) {
  const [open, setOpen] = useState(false);
  const headline = text.split('\n')[0] ?? text;

  return (
    <div className="flex items-start gap-2 py-1.5 text-[12px] text-slate-500 border-l-2 border-[var(--bark-600)] pl-3">
      <Info size={13} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        {boundary ? (
          <>
            <button onClick={() => setOpen((o) => !o)} className="text-left hover:text-slate-400">
              {headline} <span className="underline">{open ? 'hide' : 'what was kept'}</span>
            </button>
            {open && (
              <div className="mt-1.5 text-slate-400">
                <Markdown>{text}</Markdown>
              </div>
            )}
          </>
        ) : (
          <span>{text}</span>
        )}
      </div>
    </div>
  );
}
