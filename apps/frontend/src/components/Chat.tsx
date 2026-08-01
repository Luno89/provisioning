import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Bot, Loader2, Send, Square, User, AlertTriangle } from 'lucide-react';

/**
 * Talk to a model running on your own fleet — Phase A of the agent harness.
 *
 * The model endpoint itself is only reachable through a process-local kubectl port-forward on the
 * backend, so this never talks to it directly: it posts to /api/chat and the backend proxies. That
 * is also why there is no API key here to leak — the endpoint is not exposed to the network at all.
 *
 * Phase A is chat, not agency: no tools, no workspace, no task board. Those arrive with the later
 * phases; calling this an "agent" now would oversell it.
 */

interface ModelProvider {
  id: string;
  name: string;
  kind: 'vllm' | 'tabbyapi';
  model: string;
  gpuCount?: number;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function Chat({ apiBase }: { apiBase: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: models, isLoading } = useQuery<ModelProvider[]>({
    queryKey: ['models'],
    queryFn: () => axios.get(`${apiBase}/models`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (!modelId && models?.length) setModelId(models[0]!.id);
  }, [models, modelId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const next: Message[] = [...messages, { role: 'user', content: text }];
    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${apiBase}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ modelId, messages: next, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (HTTP ${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // SSE frames can split across chunk boundaries, so hold the remainder rather than parsing
      // each chunk independently — otherwise long replies drop tokens at arbitrary points.
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
            if (!delta) continue;
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last) copy[copy.length - 1] = { ...last, content: last.content + delta };
              return copy;
            });
          } catch {
            // A partial or non-JSON frame is normal mid-stream; skipping beats aborting the reply.
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  if (isLoading) {
    return <div className="flex items-center gap-2 text-slate-400 p-8"><Loader2 className="animate-spin" size={16} /> Loading models…</div>;
  }

  if (!models?.length) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-3xl font-bold mb-2">Chat</h2>
        <div className="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-6 flex gap-3">
          <AlertTriangle className="text-amber-400 shrink-0" size={20} />
          <div>
            <p className="text-slate-300 font-medium">No running model endpoints</p>
            <p className="text-sm text-slate-500 mt-1">
              Deploy a vLLM or TabbyAPI app to one of your clusters, and it will appear here once it
              reaches <span className="font-mono text-slate-400">running</span>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] max-w-4xl">
      <header className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-3xl font-bold">Chat</h2>
          <p className="text-slate-400 text-sm">Talk to a model running on your own hardware.</p>
        </div>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} — {m.model || m.kind}
            </option>
          ))}
        </select>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-2">
        {messages.length === 0 && (
          <p className="text-slate-600 text-sm">No messages yet.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className="flex gap-3">
            <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${m.role === 'user' ? 'bg-blue-600' : 'bg-slate-800'}`}>
              {m.role === 'user' ? <User size={16} /> : <Bot size={16} />}
            </div>
            <div className="flex-1 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed pt-1">
              {m.content || (streaming && i === messages.length - 1
                ? <Loader2 className="animate-spin text-slate-500" size={14} />
                : null)}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-4 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-xl px-4 py-3">{error}</div>
      )}

      <div className="mt-4 flex gap-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Send a message…  (Enter to send, Shift+Enter for a newline)"
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:border-blue-500 focus:outline-none resize-none"
        />
        {streaming ? (
          <button onClick={stop} className="px-5 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2">
            <Square size={16} /> Stop
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim()}
            className="px-5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center gap-2"
          >
            <Send size={16} /> Send
          </button>
        )}
      </div>
    </div>
  );
}
