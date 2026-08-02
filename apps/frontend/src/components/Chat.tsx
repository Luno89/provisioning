import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { consumeChunk } from '../lib/stream-delta.js';
import { Bot, Loader2, Send, Square, User, AlertTriangle, Plus, Trash2, Network, Server } from 'lucide-react';

/**
 * Talk to a model running on your own fleet — Phase A of the agent harness.
 *
 * Two kinds of model appear in one list: apps this platform deployed (reached through a
 * process-local kubectl port-forward, since their Service only resolves inside their own cluster)
 * and any OpenAI-compatible API the user registered — Ollama on their laptop, llama.cpp, a hosted
 * provider — reached directly, across the mesh when the address is in the 100.64.x.x range.
 *
 * Either way the browser never talks to the model: it posts to /api/chat and the backend proxies.
 * That is why no API key is ever handed to this component — a registered key is stored encrypted
 * and attached server-side, and the list response only reports whether one exists.
 *
 * Phase A is chat, not agency: no tools, no workspace, no task board. Those arrive with the later
 * phases; calling this an "agent" now would oversell it.
 */

interface ModelProvider {
  id: string;
  name: string;
  source: 'deployment' | 'endpoint';
  kind?: 'vllm' | 'tabbyapi';
  model: string;
  baseUrl?: string;
  isMesh?: boolean;
  hasApiKey?: boolean;
  gpuCount?: number;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Reasoning models stream `delta.reasoning_content` before any `delta.content`.
   *
   * Confirmed live against TabbyAPI serving Qwen3: a short prompt produced 35 reasoning frames
   * and then a single content frame. Parsing only `content` — as this did — left the UI showing a
   * spinner for the entire thinking phase, and with a small max_tokens budget the answer never
   * arrived at all, which looks exactly like a broken deployment.
   */
  reasoning?: string;
}

export default function Chat({ apiBase }: { apiBase: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const [showEndpoints, setShowEndpoints] = useState(false);
  const [form, setForm] = useState({ name: '', baseUrl: '', model: '', apiKey: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const { data: models, isLoading } = useQuery<ModelProvider[]>({
    queryKey: ['models'],
    queryFn: () => axios.get(`${apiBase}/models`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 30000,
  });

  const addEndpoint = useMutation({
    mutationFn: () =>
      axios.post(`${apiBase}/model-endpoints`, form, { withCredentials: true }).then((r) => r.data),
    onSuccess: () => {
      setForm({ name: '', baseUrl: '', model: '', apiKey: '' });
      setFormError(null);
      qc.invalidateQueries({ queryKey: ['models'] });
    },
    // The backend's refusal reasons are specific (which address range, why) and are the only useful
    // guidance a user gets here, so surface them rather than a generic failure.
    onError: (e: any) => setFormError(e?.response?.data?.error ?? e.message),
  });

  const removeEndpoint = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/model-endpoints/${id}`, { withCredentials: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
  });

  const endpointPanel = (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mt-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-medium text-slate-200">Endpoints</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Any OpenAI-compatible API — Ollama, llama.cpp, LM Studio, or a hosted provider.
          </p>
        </div>
        <button
          onClick={() => setShowEndpoints((v) => !v)}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm flex items-center gap-2"
        >
          <Plus size={14} /> {showEndpoints ? 'Close' : 'Add'}
        </button>
      </div>

      {showEndpoints && (
        <div className="mt-4 space-y-3">
          {([
            ['name', 'Name', 'Laptop Ollama'],
            ['baseUrl', 'Base URL', 'http://100.64.0.7:11434/v1'],
            ['model', 'Model (optional)', 'llama3.1'],
            ['apiKey', 'API key (optional)', ''],
          ] as const).map(([key, label, placeholder]) => (
            <div key={key}>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</label>
              <input
                type={key === 'apiKey' ? 'password' : 'text'}
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none"
              />
            </div>
          ))}
          <p className="text-[11px] text-slate-500">
            A machine on your mesh uses its <span className="font-mono">100.64.x.x</span> address — join it under
            My Machines first. Private, loopback and internal addresses are refused.
          </p>
          {formError && <p className="text-[11px] text-red-400">{formError}</p>}
          <button
            onClick={() => addEndpoint.mutate()}
            disabled={!form.name.trim() || !form.baseUrl.trim() || addEndpoint.isPending}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm flex items-center gap-2"
          >
            {addEndpoint.isPending ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />} Register
          </button>
        </div>
      )}

      {models?.some((m) => m.source === 'endpoint') && (
        <ul className="mt-4 space-y-2">
          {models.filter((m) => m.source === 'endpoint').map((m) => (
            <li key={m.id} className="flex items-center gap-3 text-sm bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
              {m.isMesh ? <Network size={14} className="text-blue-400" /> : <Server size={14} className="text-slate-500" />}
              <span className="text-slate-200">{m.name}</span>
              <span className="font-mono text-[11px] text-slate-500 truncate flex-1">{m.baseUrl}</span>
              {m.hasApiKey && <span className="text-[10px] text-slate-500 uppercase tracking-wider">key</span>}
              <button onClick={() => removeEndpoint.mutate(m.id)} className="text-slate-500 hover:text-red-400">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

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
      // Buffer lives here because SSE frames split across network chunks; consumeChunk is pure and
      // tested (lib/stream-delta.ts) precisely because this parser has broken twice.
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const r = consumeChunk(buffer, decoder.decode(value, { stream: true }));
        buffer = r.buffer;
        if (!r.delta.content && !r.delta.reasoning) continue;
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (!last) return copy;
          copy[copy.length - 1] = {
            ...last,
            ...(r.delta.content ? { content: last.content + r.delta.content } : {}),
            ...(r.delta.reasoning ? { reasoning: (last.reasoning ?? '') + r.delta.reasoning } : {}),
          };
          return copy;
        });
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
            <p className="text-slate-300 font-medium">No models yet</p>
            <p className="text-sm text-slate-500 mt-1">
              Deploy a vLLM or TabbyAPI app to one of your clusters, or register any
              OpenAI-compatible endpoint below — including one running on your own machine over the
              mesh.
            </p>
          </div>
        </div>
        {endpointPanel}
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
              {m.name} — {m.model || m.kind || (m.isMesh ? 'mesh' : 'endpoint')}
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
            <div className="flex-1 pt-1 min-w-0">
              {m.reasoning && (
                <details className="mb-2 group" open={!m.content}>
                  <summary className="text-[11px] uppercase tracking-widest text-slate-500 cursor-pointer select-none">
                    Thinking{!m.content && streaming && i === messages.length - 1 ? '…' : ''}
                  </summary>
                  <div className="mt-1 text-[12px] text-slate-500 whitespace-pre-wrap leading-relaxed border-l-2 border-slate-800 pl-3">
                    {m.reasoning}
                  </div>
                </details>
              )}
              <div className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
                {m.content || (streaming && i === messages.length - 1 && !m.reasoning
                  ? <Loader2 className="animate-spin text-slate-500" size={14} />
                  : null)}
              </div>
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

      {endpointPanel}
    </div>
  );
}
