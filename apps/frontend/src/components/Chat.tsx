import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { consumeChunk, splitThinkTags } from '../lib/stream-delta.js';
import { KoalaSpot } from './Koala.js';
import { splitProposalBlock } from '../lib/proposal-display.js';
import { Bot, Loader2, Send, Square, User, AlertTriangle, Plus, Trash2, Network, Server, Sprout, Check, X, Sliders } from 'lucide-react';

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

export interface ProposedLeaf {
  id: string;
  title: string;
  body?: string;
}

export interface Message {
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
  interruptedReason?: string;
}

type Mode = 'chat' | 'auto' | 'plan';

const MODE_HINT: Record<Mode, string> = {
  chat: 'just talking — nothing is created',
  auto: 'work is extracted from every reply',
  plan: 'actively breaking the work down',
};

export default function Chat({
  apiBase, branchId, mode = 'auto', onModeChange, onProposals,
  messages, onMessagesChange, proposed = [], onAccept, onReject, onAcceptAll,
}: {
  apiBase: string;
  /** The branch any proposals land on. */
  branchId?: string;
  /** chat = no side effects; auto = extract after every reply; plan = also ask the model to plan. */
  mode?: Mode;
  /** Switching happens through a slash command, so the parent owns the value. */
  onModeChange?: (mode: Mode) => void;
  /** Called once a reply finishes, so the tree picks up anything that was proposed. */
  onProposals?: () => void;
  /**
   * The transcript, owned by the parent. Chat unmounts every time a leaf is selected, so keeping
   * this in component state lost the conversation on a single click.
   */
  messages: Message[];
  onMessagesChange: (next: Message[] | ((prev: Message[]) => Message[])) => void;
  /** This branch's proposed leaves — real records, so accept/reject act on the actual thing. */
  proposed?: ProposedLeaf[];
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
  onAcceptAll?: () => void;
}) {
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const [showEndpoints, setShowEndpoints] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [temperature, setTemperature] = useState<number>(0.7);
  const [frequencyPenalty, setFrequencyPenalty] = useState<number>(0.4);
  const [presencePenalty, setPresencePenalty] = useState<number>(0.2);
  const [maxTokens, setMaxTokens] = useState<number>(2048);
  const [thoughtSensitivity, setThoughtSensitivity] = useState<'low' | 'medium' | 'high'>('medium');
  const [ngramCap, setNgramCap] = useState(5);
  const [failureThreshold, setFailureThreshold] = useState(0.85);
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

  // Only rendered in the empty state. In a live conversation it added height below the composer
  // and pushed the transcript out of view — the second half of the double-scroll problem.
  const endpointPanel = (
    <div className="bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl p-5 mt-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-medium text-slate-200">Endpoints</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Any OpenAI-compatible API — Ollama, llama.cpp, LM Studio, or a hosted provider.
          </p>
        </div>
        <button
          onClick={() => setShowEndpoints((v) => !v)}
          className="px-3 py-1.5 rounded-lg bg-[var(--bark-700)] hover:bg-slate-700 text-sm flex items-center gap-2"
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
                className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-2 text-sm font-mono focus:border-[var(--leaf)] focus:outline-none"
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
            className="px-4 py-2 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-40 text-sm flex items-center gap-2"
          >
            {addEndpoint.isPending ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />} Register
          </button>
        </div>
      )}

      {models?.some((m) => m.source === 'endpoint') && (
        <ul className="mt-4 space-y-2">
          {models.filter((m) => m.source === 'endpoint').map((m) => (
            <li key={m.id} className="flex items-center gap-3 text-sm bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-2">
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

    /**
     * A leading /chat, /auto or /plan switches mode.
     *
     * Bare — send nothing, just switch. With text — switch and send it, so "/plan add rate
     * limiting" does the obvious thing rather than making you set the mode and then retype.
     *
     * Note /plan is ALSO parsed server-side as a per-turn override. That is deliberate belt and
     * braces: this switch is optimistic local state, and the server must not depend on the client
     * having applied it before the request lands.
     */
    const command = /^\/(chat|auto|plan)\b\s*([\s\S]*)$/i.exec(text);
    if (command) {
      const next = command[1]!.toLowerCase() as Mode;
      const rest = (command[2] ?? '').trim();
      onModeChange?.(next);
      setInput('');
      setError(null);
      // Nothing else to send — the user only wanted to switch.
      if (!rest) return;
      // Fall through with the remainder, sent under the mode just selected. `/plan` keeps its
      // prefix so the server applies the same override even if this component's state has not
      // propagated yet.
      return sendMessage(next === 'plan' ? `/plan ${rest}` : rest, next);
    }

    return sendMessage(text, mode);
  };

  const sendMessage = async (text: string, activeMode: Mode) => {

    const next: Message[] = [...messages, { role: 'user', content: text }];
    onMessagesChange([...next, { role: 'assistant', content: '' }]);
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
        body: JSON.stringify({
          modelId,
          messages: next,
          stream: true,
          branchId,
          mode: activeMode,
          temperature,
          frequency_penalty: frequencyPenalty,
          presence_penalty: presencePenalty,
          max_tokens: maxTokens,
          thoughtMonitorSensitivity: thoughtSensitivity,
          ngramRepeatThreshold: ngramCap,
          failurePredictionThreshold: failureThreshold,
        }),
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
        let deltaContent = r.delta.content;
        let deltaReasoning = r.delta.reasoning;
        if (deltaContent.includes('<think>')) {
          const split = splitThinkTags(deltaContent);
          deltaContent = split.content;
          deltaReasoning += split.reasoning;
        }

        if (!deltaContent && !deltaReasoning && !r.delta.interruptedReason) continue;
        onMessagesChange((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (!last) return copy;
          const combinedContent = last.content + deltaContent;
          const finalSplit = combinedContent.includes('<think>') ? splitThinkTags(combinedContent) : null;
          copy[copy.length - 1] = {
            ...last,
            content: finalSplit ? finalSplit.content : combinedContent,
            reasoning: (last.reasoning ?? '') + deltaReasoning + (finalSplit ? finalSplit.reasoning : ''),
            ...(r.delta.interruptedReason ? { interruptedReason: r.delta.interruptedReason } : {}),
          };
          return copy;
        });
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Proposals are created server-side after the stream closes. Chat mode never produces any,
      // so refreshing then is harmless but pointless.
      if (activeMode !== 'chat') onProposals?.();
    }
  };

  /**
   * Accept/reject for this branch's proposals.
   *
   * Held in a variable rather than written inline because it has to survive the no-models early
   * return below: proposals are real records, and a branch that already has some must stay
   * actionable even when there is nothing to chat with — an endpoint going away should not strand
   * work that was already proposed.
   */
  const proposalPanel = proposed.length > 0 && (
    
      <div className="mt-3 shrink-0 rounded-xl border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/10 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Sprout size={13} className="text-[var(--leaf-light)]" />
          <h3 className="text-[11px] uppercase tracking-widest text-[var(--leaf-light)] flex-1">
            {proposed.length} sprouting
          </h3>
          {proposed.length > 1 && onAcceptAll && (
            <button
              onClick={onAcceptAll}
              className="text-[11px] px-2 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white"
            >
              Accept all
            </button>
          )}
        </div>
        <ul className="space-y-1.5 max-h-52 overflow-y-auto">
          {proposed.map((p) => (
            <li key={p.id} className="flex items-start gap-2 rounded-lg bg-[var(--bark-800)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-slate-200">{p.title}</p>
                {p.body && <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{p.body}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => onAccept?.(p.id)} title="Accept — starts the work"
                  className="p-1 rounded-md text-[var(--leaf-light)] hover:bg-[var(--bark-700)]"><Check size={14} /></button>
                <button onClick={() => onReject?.(p.id)} title="Reject"
                  className="p-1 rounded-md text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]"><X size={14} /></button>
              </div>
            </li>
          ))}
        </ul>
      </div>
  );

  if (isLoading) {
    return <div className="flex items-center gap-2 text-slate-400 p-8"><Loader2 className="animate-spin" size={16} /> Loading models…</div>;
  }

  if (!models?.length) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-3xl font-bold mb-2">Chat</h2>
        <div className="mt-6 bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl p-6 flex gap-3">
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
        {proposalPanel}
        {endpointPanel}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 max-w-4xl">
      <header className="flex justify-end items-center gap-2 mb-3 shrink-0 relative">
        <button
          onClick={() => setShowSettings(!showSettings)}
          title="Thought Monitor Tunables"
          className={`p-2 rounded-xl border border-[var(--bark-600)] transition-colors flex items-center gap-1.5 text-xs font-medium ${
            showSettings ? 'bg-[var(--leaf)] text-slate-900 border-[var(--leaf)]' : 'bg-[var(--bark-900)] text-slate-300 hover:bg-[var(--bark-800)]'
          }`}
        >
          <Sliders size={14} />
          <span>Tunables</span>
        </button>

        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          className="bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-[var(--leaf)] focus:outline-none"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} — {m.model || m.kind || (m.isMesh ? 'mesh' : 'endpoint')}
            </option>
          ))}
        </select>

        {showSettings && (
          <div className="absolute top-12 right-0 z-20 w-88 bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl p-4 shadow-xl text-xs space-y-3.5 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--bark-700)]">
              <span className="font-semibold text-slate-200">System-Wide Model Tunables</span>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-200">
                <X size={14} />
              </button>
            </div>

            <div className="space-y-2.5">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--leaf-light)]">Sampling Controls</div>
              
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Temperature</span>
                  <span className="font-mono text-slate-200">{temperature.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.5"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Frequency Penalty</span>
                  <span className="font-mono text-slate-200">{frequencyPenalty.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.5"
                  step="0.05"
                  value={frequencyPenalty}
                  onChange={(e) => setFrequencyPenalty(Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Presence Penalty</span>
                  <span className="font-mono text-slate-200">{presencePenalty.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.5"
                  step="0.05"
                  value={presencePenalty}
                  onChange={(e) => setPresencePenalty(Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Max Completion Tokens</span>
                  <span className="font-mono text-slate-200">{maxTokens}</span>
                </div>
                <input
                  type="range"
                  min="512"
                  max="8192"
                  step="256"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>
            </div>

            <div className="space-y-2.5 pt-2 border-t border-[var(--bark-700)]">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--leaf-light)]">ML Thought Monitor</div>

              <div>
                <label className="block text-slate-400 mb-1">Thought Monitor Sensitivity</label>
                <select
                  value={thoughtSensitivity}
                  onChange={(e) => setThoughtSensitivity(e.target.value as any)}
                  className="w-full bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-lg px-2.5 py-1.5 text-slate-200"
                >
                  <option value="low">Low (relaxed)</option>
                  <option value="medium">Medium (balanced)</option>
                  <option value="high">High (strict)</option>
                </select>
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>N-Gram Repeat Cap</span>
                  <span className="font-mono text-slate-200">{ngramCap}</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="10"
                  value={ngramCap}
                  onChange={(e) => setNgramCap(Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Failure Prediction Cutoff</span>
                  <span className="font-mono text-slate-200">{(failureThreshold * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0.50"
                  max="0.99"
                  step="0.05"
                  value={failureThreshold}
                  onChange={(e) => setFailureThreshold(Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-2">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            {/* Drop a real GIF in later by giving KoalaSpot a src — the SVG stands in until then,
                so an empty conversation never looks like a failed load. */}
            <KoalaSpot size={88} mood="idle" className="sway opacity-80" />
            <p className="text-slate-500 text-sm">Ask me something.</p>
            <p className="text-slate-600 text-[11px] font-mono">/chat · /auto · /plan</p>
          </div>
        )}
        {messages.map((m, i) => {
          const reasoning = m.reasoning;
          const { prose, proposals, pending } = splitProposalBlock(m.content);
          const waiting = streaming && i === messages.length - 1 && !reasoning && !prose;

          return (
            <div key={i} className="flex gap-3">
              <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${m.role === 'user' ? 'bg-blue-600' : 'bg-[var(--bark-700)]'}`}>
                {m.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              <div className="flex-1 pt-1 min-w-0">
                {reasoning && (
                  <details className="mb-2 group" open={!prose}>
                    <summary className="text-[11px] uppercase tracking-widest text-slate-500 cursor-pointer select-none">
                      Thinking{!prose && streaming && i === messages.length - 1 ? '…' : ''}
                    </summary>
                    <div className="mt-1 text-[12px] text-slate-500 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--bark-600)] pl-3">
                      {reasoning}
                    </div>
                  </details>
                )}

                <div className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
                  {prose || (waiting ? <Loader2 className="animate-spin text-slate-500" size={14} /> : null)}
                </div>

                {m.interruptedReason && (
                  <div className="mt-2 text-xs text-amber-400 bg-amber-950/40 border border-amber-800/60 rounded-lg px-3 py-2 flex items-center gap-2 select-none">
                    <AlertTriangle size={14} className="shrink-0 text-amber-400" />
                    <span><strong>Interrupted:</strong> {m.interruptedReason}</span>
                  </div>
                )}

                    {pending && (
                      <p className="mt-2 text-[11px] text-[var(--leaf-light)] flex items-center gap-1.5">
                        <Sprout size={11} className="animate-pulse" /> proposing work…
                      </p>
                    )}

                    {proposals.length > 0 && (
                      <p className="mt-2 text-[11px] text-[var(--leaf-light)] flex items-center gap-1.5">
                        <Sprout size={11} /> proposed {proposals.length} leaf{proposals.length > 1 ? 'ves' : ''}
                      </p>
                    )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-xl px-4 py-3">{error}</div>
      )}

      {proposalPanel}

      <div className="mt-3 flex gap-3 shrink-0">
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
          placeholder="Send a message…  (/chat, /auto or /plan to switch mode)"
          className="flex-1 bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl px-4 py-3 text-sm text-slate-200 focus:border-[var(--leaf)] focus:outline-none resize-none"
        />
        {streaming ? (
          <button onClick={stop} className="px-5 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2">
            <Square size={16} /> Stop
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim()}
            className="px-5 rounded-xl bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-40 flex items-center gap-2"
          >
            <Send size={16} /> Send
          </button>
        )}
      </div>

      {/* Below the input rather than above it: the mode is a property of what you are about to
          send, and it belongs next to where you type rather than competing with the transcript. */}
      <div className="mt-2 flex items-center gap-2 text-[11px] shrink-0">
        <span className={`font-mono ${mode === 'chat' ? 'text-slate-500' : mode === 'plan' ? 'text-emerald-400' : 'text-blue-400'}`}>
          /{mode}
        </span>
        <span className="text-slate-600">{MODE_HINT[mode]}</span>
      </div>
    </div>
  );
}
