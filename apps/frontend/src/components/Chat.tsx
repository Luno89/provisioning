import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { consumeChunk, splitThinkTags } from '../lib/stream-delta.js';
import { KoalaSpot } from './Koala.js';
import { splitProposalBlock } from '../lib/proposal-display.js';
import Markdown from './Markdown.js';
import { Bot, Loader2, Send, Square, User, AlertTriangle, Sprout, Check, X, Sliders, Info } from 'lucide-react';
import { openChatStream } from '../api/chat';
import {
  listModels, providerKeys, type ModelProvider,
} from '../api/models';
import { listPersonas, personaKeys } from '../api/personas';
import { getConfig, profileKeys } from '../api/harness';

export interface ProposedLeaf {
  id: string;
  title: string;
  body?: string;
  personaId?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  notice?: boolean;
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
  branchId, mode = 'auto', onModeChange, onProposals,
  messages, onMessagesChange, proposed = [], onAccept, onReject, onAcceptAll,
  autoSend, onAutoSent,
}: {
  branchId?: string;
  mode?: Mode;
  onModeChange?: (mode: Mode) => void;
  onProposals?: () => void;
  autoSend?: string | undefined;
  onAutoSent?: () => void;
  messages: Message[];
  onMessagesChange: (next: Message[] | ((prev: Message[]) => Message[])) => void;
  proposed?: ProposedLeaf[];
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
  onAcceptAll?: () => void;
}) {
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const observerRef = useRef<MutationObserver | null>(null);
  const qc = useQueryClient();

  const [showSettings, setShowSettings] = useState(false);
  const [touched, setTouched] = useState<Record<string, number>>({});
  const setKnob = (key: string, value: number) => setTouched((t) => ({ ...t, [key]: value }));
  const releaseKnob = (key: string) => setTouched(({ [key]: _dropped, ...rest }) => rest);
  const [thoughtSensitivity, setThoughtSensitivity] = useState<'low' | 'medium' | 'high'>('medium');
  const [ngramCap, setNgramCap] = useState(5);
  const [failureThreshold, setFailureThreshold] = useState(0.85);

  const { data: models, isLoading } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    refetchInterval: 30000,
  });

  const { data: harness } = useQuery<{
    effective?: { key: string; value: unknown; source?: 'harness' | 'adopted' }[];
  }>({
    queryKey: profileKeys.config(),
    queryFn: getConfig,
    staleTime: 60_000,
  });
  const knob = (key: string, fallback: number): number => {
    if (touched[key] !== undefined) return touched[key]!;
    const persona = personas?.find((p) => p.id === personaId)?.overrides?.[key];
    if (typeof persona === 'number') return persona;
    const live = harness?.effective?.find((e) => e.key === key)?.value;
    return typeof live === 'number' ? live : fallback;
  };

  const knobSource = (key: string): string => {
    if (touched[key] !== undefined) return 'you';
    if (personas?.find((p) => p.id === personaId)?.overrides?.[key] !== undefined) return 'persona';
    return harness?.effective?.find((e) => e.key === key)?.source === 'adopted' ? 'adopted' : 'built-in';
  };

  const { data: personas } = useQuery<{
    id: string; name: string; description?: string; overrides?: Record<string, unknown>;
    scope?: { mcp?: string[] };
  }[]>({
    queryKey: personaKeys.list(),
    queryFn: listPersonas,
  });

  const activePersona = personas?.find((p) => p.id === personaId);

  useEffect(() => {
    if (!modelId && models?.length) setModelId(models[0]!.id);
  }, [models, modelId]);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
  }, []);

  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    scrollRef.current = el;
    if (!el) return;
    pinnedRef.current = true;
    pin();
    const mo = new MutationObserver(() => { if (pinnedRef.current) pin(); });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    observerRef.current = mo;
  }, [pin]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  useEffect(() => {
    pinnedRef.current = true;
    const id = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(id);
  }, [branchId, messages, pin]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const command = /^\/(chat|auto|plan)\b\s*([\s\S]*)$/i.exec(text);
    if (command) {
      const next = command[1]!.toLowerCase() as Mode;
      const rest = (command[2] ?? '').trim();
      onModeChange?.(next);
      setInput('');
      setError(null);
      if (!rest) return;
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
      const res = await openChatStream({
        modelId,
        messages: next,
        stream: true,
        branchId,
        mode: activeMode,
        ...(personaId ? { personaId } : {}),
        ...touched,
        thoughtMonitorSensitivity: thoughtSensitivity,
        ngramRepeatThreshold: ngramCap,
        failurePredictionThreshold: failureThreshold,
      }, controller.signal);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
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
      if (activeMode !== 'chat') onProposals?.();
    }
  };

  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || autoSentRef.current === autoSend || streaming) return;
    autoSentRef.current = autoSend;
    onAutoSent?.();
    void sendMessage(autoSend, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend]);

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
              disabled={proposed.some((p) => !p.personaId)}
              title={proposed.some((p) => !p.personaId) ? 'Some of these have nobody assigned' : undefined}
              className="text-[11px] px-2 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-40 text-white"
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
                {!p.personaId && (
                  <p className="text-[11px] text-amber-400/90 mt-1 flex items-center gap-1">
                    <AlertTriangle size={11} /> needs a persona before it can run
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => onAccept?.(p.id)} disabled={!p.personaId}
                  title={p.personaId ? 'Accept — starts the work' : 'Assign a persona first'}
                  className="p-1 rounded-md text-[var(--leaf-light)] hover:bg-[var(--bark-700)] disabled:opacity-30"><Check size={14} /></button>
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
              Deploy a vLLM or TabbyAPI app to your cluster, or connect an AI provider in
              Cloud Accounts — they all appear here as options.
            </p>
          </div>
        </div>
        {proposalPanel}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 max-w-4xl">
      <header className="flex justify-end items-center gap-2 mb-2 shrink-0 relative">
        <button
          onClick={() => setShowSettings(!showSettings)}
          title="Who answers, which model, and how it samples"
          className={`px-2.5 py-1 rounded-lg border transition-colors flex items-center gap-1.5 text-[11px] max-w-full ${
            showSettings
              ? 'bg-[var(--leaf)] text-slate-900 border-[var(--leaf)]'
              : 'bg-[var(--bark-900)] text-slate-400 border-[var(--bark-700)] hover:text-slate-200'
          }`}
        >
          <Sliders size={12} className="shrink-0" />
          <span className="truncate">
            {personas?.find((p) => p.id === personaId)?.name ?? 'No persona'}
            {' · '}
            {models.find((m) => m.id === modelId)?.name ?? 'model'}
          </span>
        </button>

        {showSettings && (
          <div className="absolute top-9 right-0 z-20 w-88 bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl p-4 shadow-xl text-xs space-y-3.5 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--bark-700)]">
              <span className="font-semibold text-slate-200">Who answers, and how</span>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-200">
                <X size={14} />
              </button>
            </div>

            {personas && personas.length > 0 && (
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-[var(--leaf-light)] mb-1.5">Persona</div>
                <select
                  value={personaId}
                  onChange={(e) => setPersonaId(e.target.value)}
                  title="Who answers — a named prompt and sampling configuration"
                  className="w-full bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-lg px-3 py-1.5 text-[12px] text-slate-200 focus:border-[var(--leaf)] focus:outline-none"
                >
                  <option value="">No persona</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--leaf-light)] mb-1.5">Model</div>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="w-full bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-lg px-3 py-1.5 text-[12px] text-slate-200 focus:border-[var(--leaf)] focus:outline-none"
              >
                {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      [{m.sourceLabel || (m.source === 'deployment' ? (m.kind === 'tabbyapi' ? 'TabbyAPI' : 'vLLM') : 'Custom')}] {m.model || m.name}
                    </option>
                  ))}
              </select>
            </div>

            <div className="space-y-2.5">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--leaf-light)]">Sampling Controls</div>
              
              <p className="text-[10px] text-slate-500 leading-snug mb-1">
                Showing what the harness is set to. Move a control to override it for this
                conversation only; anything untouched follows the adopted defaults.
              </p>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Temperature</span>
                  <span className="font-mono text-slate-200">
                    {knob('temperature', 0.7).toFixed(2)}
                    {knobSource('temperature') === 'you' ? (
                      <button
                        onClick={() => releaseKnob('temperature')}
                        title="Hand this back to the persona or the adopted default"
                        className="ml-1.5 text-[10px] font-sans text-amber-400 hover:text-amber-300 underline decoration-dotted"
                      >you ✕</button>
                    ) : (
                      <span className="ml-1.5 text-[10px] font-sans text-slate-500">{knobSource('temperature')}</span>
                    )}
                  </span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.5"
                  step="0.05"
                  value={knob('temperature', 0.7)}
                  onChange={(e) => setKnob('temperature', Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Frequency Penalty</span>
                  <span className="font-mono text-slate-200">
                    {knob('frequency_penalty', 0.4).toFixed(2)}
                    {knobSource('frequency_penalty') === 'you' ? (
                      <button
                        onClick={() => releaseKnob('frequency_penalty')}
                        title="Hand this back to the persona or the adopted default"
                        className="ml-1.5 text-[10px] font-sans text-amber-400 hover:text-amber-300 underline decoration-dotted"
                      >you ✕</button>
                    ) : (
                      <span className="ml-1.5 text-[10px] font-sans text-slate-500">{knobSource('frequency_penalty')}</span>
                    )}
                  </span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.5"
                  step="0.05"
                  value={knob('frequency_penalty', 0.4)}
                  onChange={(e) => setKnob('frequency_penalty', Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Presence Penalty</span>
                  <span className="font-mono text-slate-200">
                    {knob('presence_penalty', 0.2).toFixed(2)}
                    {knobSource('presence_penalty') === 'you' ? (
                      <button
                        onClick={() => releaseKnob('presence_penalty')}
                        title="Hand this back to the persona or the adopted default"
                        className="ml-1.5 text-[10px] font-sans text-amber-400 hover:text-amber-300 underline decoration-dotted"
                      >you ✕</button>
                    ) : (
                      <span className="ml-1.5 text-[10px] font-sans text-slate-500">{knobSource('presence_penalty')}</span>
                    )}
                  </span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.5"
                  step="0.05"
                  value={knob('presence_penalty', 0.2)}
                  onChange={(e) => setKnob('presence_penalty', Number(e.target.value))}
                  className="w-full accent-[var(--leaf)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Max Completion Tokens</span>
                  <span className="font-mono text-slate-200">{knob('max_tokens', 2048)}</span>
                </div>
                <input
                  type="range"
                  min="512"
                  max="8192"
                  step="256"
                  value={knob('max_tokens', 2048)}
                  onChange={(e) => setKnob('max_tokens', Number(e.target.value))}
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

      <div
        ref={attachScroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-2"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <KoalaSpot size={88} mood="idle" className="sway opacity-80" />
            <p className="text-slate-500 text-sm">Ask me something.</p>
            <p className="text-slate-600 text-[11px] font-mono">/chat · /auto · /plan</p>
          </div>
        )}
        {messages.map((m, i) => {
          const reasoning = m.reasoning;
          const { prose, proposals, pending } = splitProposalBlock(m.content);
          const waiting = streaming && i === messages.length - 1 && !reasoning && !prose;

          if (m.notice) {
            return (
              <div key={i} className="flex gap-3">
                <div className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-600">
                  <Info size={15} />
                </div>
                <div className="flex-1 pt-1 min-w-0 text-[12px] text-slate-400 leading-relaxed
                                border-l-2 border-[var(--bark-600)] pl-3 py-1">
                  <Markdown>{m.content}</Markdown>
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="flex gap-3">
              <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${m.role === 'user' ? 'bg-blue-600' : 'bg-[var(--bark-700)]'}`}>
                {m.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              <div className="flex-1 pt-1 min-w-0">
                {reasoning?.trim() && (
                  <details className="mb-2 group" open={!prose}>
                    <summary className="text-[11px] uppercase tracking-widest text-slate-500 cursor-pointer select-none">
                      Thinking{!prose && streaming && i === messages.length - 1 ? '…' : ''}
                    </summary>
                    <div className="mt-1 text-[12px] text-slate-500 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--bark-600)] pl-3">
                      {reasoning.trim()}
                    </div>
                  </details>
                )}

                <div className="text-sm text-slate-200 leading-relaxed">
                  {prose
                    ? <Markdown>{prose}</Markdown>
                    : (waiting ? <Loader2 className="animate-spin text-slate-500" size={14} /> : null)}
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

      <div className="mt-3 flex items-center gap-2 text-[11px] shrink-0">
        <span className="text-slate-500">Answering:</span>
        {activePersona ? (
          <>
            <span className="px-2 py-0.5 rounded-md bg-[var(--leaf)]/15 border border-[var(--leaf)]/40 text-slate-200">
              {activePersona.name}
            </span>
            {(activePersona.scope?.mcp ?? []).length > 0 && (
              <span className="text-slate-500">
                can call {(activePersona.scope?.mcp ?? []).join(', ')}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="px-2 py-0.5 rounded-md border border-[var(--bark-600)] text-slate-400">
              No persona
            </span>
            <span className="text-slate-500">default prompt, no services</span>
          </>
        )}
      </div>

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

      <div className="mt-2 flex items-center gap-2 text-[11px] shrink-0">
        <span className={`font-mono ${mode === 'chat' ? 'text-slate-500' : mode === 'plan' ? 'text-emerald-400' : 'text-blue-400'}`}>
          /{mode}
        </span>
        <span className="text-slate-600">{MODE_HINT[mode]}</span>
      </div>
    </div>
  );
}
