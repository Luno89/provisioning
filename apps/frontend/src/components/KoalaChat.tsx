import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { MessageSquarePlus, Trash2, Plug, Sprout, Send, Loader2 } from 'lucide-react';

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

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** Deliberation, kept apart from the answer so it can be collapsed. */
  reasoning?: string;
  at: string;
  /** Services hooked up while producing this message — a record, not the model's claim. */
  enabled?: string[];
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  proposedTrees?: ProposedTree[];
  updatedAt: string;
}

export default function KoalaChat({ apiBase, onOpenTree }: {
  apiBase: string;
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
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** One per mount. What "session" means for the services Koala hooks up. */
  const sessionId = useRef(Math.random().toString(36).slice(2));

  const { data: threads } = useQuery<(Conversation & { messageCount: number })[]>({
    queryKey: ['koala-conversations'],
    queryFn: async () => (await axios.get(`${apiBase}/koala/conversations`, { withCredentials: true })).data,
    refetchInterval: 15000,
  });

  const { data: thread } = useQuery<Conversation>({
    queryKey: ['koala-conversation', selected],
    queryFn: async () => (await axios.get(`${apiBase}/koala/conversations/${selected}`, { withCredentials: true })).data,
    enabled: Boolean(selected),
  });

  const create = useMutation({
    mutationFn: async () => (await axios.post(`${apiBase}/koala/conversations`, {}, { withCredentials: true })).data,
    onSuccess: (c: Conversation) => { setSelected(c.id); qc.invalidateQueries({ queryKey: ['koala-conversations'] }); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/koala/conversations/${id}`, { withCredentials: true }),
    onSuccess: (_, id) => {
      if (selected === id) setSelected(null);
      qc.invalidateQueries({ queryKey: ['koala-conversations'] });
    },
  });

  const accept = useMutation({
    mutationFn: (proposalId: string) => axios.post(
      `${apiBase}/koala/conversations/${selected}/proposals/${proposalId}/accept`, {}, { withCredentials: true },
    ),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['koala-conversation', selected] });
      qc.invalidateQueries({ queryKey: ['trees'] });
      if (res?.data?.tree?.id) onOpenTree?.(res.data.tree.id);
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
    try {
      const res = await fetch(`${apiBase}/koala/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ conversationId: id, message: text, sessionId: sessionId.current }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);

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
            if (frame.proposedTree) qc.invalidateQueries({ queryKey: ['koala-conversation', id] });
          } catch { /* a partial frame; the next chunk completes it */ }
        }
      }
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setStreaming(false);
      setLive('');
      setLiveThinking('');
      setLiveEnabled([]);
      qc.invalidateQueries({ queryKey: ['koala-conversation', id] });
      qc.invalidateQueries({ queryKey: ['koala-conversations'] });
    }
  };

  const proposals = (thread?.proposedTrees ?? []);

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
            <div key={i} className={m.role === 'user' ? 'self-end max-w-[80%]' : 'max-w-[85%]'}>
              {m.enabled?.length ? <EnabledLine names={m.enabled} /> : null}
              {m.reasoning?.trim() ? <Thinking text={m.reasoning} /> : null}
              <div className={`rounded-2xl px-4 py-2.5 text-[14px] whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-[var(--leaf-stem)] text-white'
                  : 'bg-[var(--bark-800)] text-slate-200 border border-[var(--bark-600)]'}`}
              >
                {m.content}
              </div>
            </div>
          ))}

          {liveEnabled.length > 0 && <EnabledLine names={liveEnabled} />}
          {liveThinking.trim() && <Thinking text={liveThinking} open={!live} live={!live} />}
          {live && (
            <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] whitespace-pre-wrap bg-[var(--bark-800)] text-slate-200 border border-[var(--bark-600)]">
              {live}
            </div>
          )}
          {streaming && !live && !liveThinking && (
            <div className="flex items-center gap-2 text-[12px] text-slate-500">
              <Loader2 size={13} className="animate-spin" /> Koala is thinking…
            </div>
          )}

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
