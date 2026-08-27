import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { consumeChunk, splitThinkTags } from '../lib/stream-delta.js';
import { KoalaSpot } from './Koala.js';
import { splitProposalBlock } from '../lib/proposal-display.js';
import Markdown from './Markdown.js';
import { Bot, Loader2, Send, Square, User, AlertTriangle, Plus, Trash2, Network, Server, Sprout, Check, X, Sliders, Info } from 'lucide-react';
import { openChatStream } from '../api/chat';
import {
  listModels, addModelEndpoint, removeModelEndpoint, providerKeys, type ModelProvider,
} from '../api/models';
import { listPersonas, personaKeys } from '../api/personas';
import { getConfig, profileKeys } from '../api/harness';
import { errorMessage } from '../api/client';

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

export interface ProposedLeaf {
  id: string;
  title: string;
  body?: string;
  /**
   * Who will do it.
   *
   * A persona carries the whole environment — image, network, tools, budget, where the output goes
   * — so a proposal without one cannot run, and accepting it would only fail later.
   */
  personaId?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Written by the system, not said by anyone — a leaf failing, an acceptance verdict, a warning
   * about the plan.
   *
   * It carries the assistant role because `BranchMessage` has no system role, which meant these
   * rendered as Koala talking: an automated report of a failure was indistinguishable from the
   * model claiming to have noticed it. Styling them as events is the difference between reading
   * "the harness observed this" and "the assistant said this".
   */
  notice?: boolean;
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
  branchId, mode = 'auto', onModeChange, onProposals,
  messages, onMessagesChange, proposed = [], onAccept, onReject, onAcceptAll,
  autoSend, onAutoSent,
}: {
  /** The branch any proposals land on. */
  branchId?: string;
  /** chat = no side effects; auto = extract after every reply; plan = also ask the model to plan. */
  mode?: Mode;
  /** Switching happens through a slash command, so the parent owns the value. */
  onModeChange?: (mode: Mode) => void;
  /** Called once a reply finishes, so the tree picks up anything that was proposed. */
  onProposals?: () => void;
  /**
   * A message to send without the user typing it.
   *
   * How a failure review arrives: the board hands over the evidence and the question, and the
   * answer is an ordinary turn. Sent ONCE — `onAutoSent` clears it, because a prop that survives a
   * re-render would send the same message again every time the component updates.
   */
  autoSend?: string | undefined;
  onAutoSent?: () => void;
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
  // Empty means nobody in particular, which is the default and a real choice — not a missing one.
  const [personaId, setPersonaId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whether the reader is following the newest message, as opposed to having scrolled up to read.
   *
   * Kept in a ref, not state: it is read inside a ResizeObserver and updated on every scroll event,
   * and neither should re-render the conversation.
   */
  const pinnedRef = useRef(true);
  const observerRef = useRef<MutationObserver | null>(null);
  const qc = useQueryClient();

  const [showEndpoints, setShowEndpoints] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * Sampling the user has DELIBERATELY changed — not every value the panel displays.
   *
   * These used to be plain numbers seeded with invented defaults (0.7, 0.4, 0.2) and sent on every
   * single turn. That put them at the request layer, which outranks everything, so the adopted
   * harness profile could never take effect — and the 0.4 frequency penalty it kept reinstating is
   * the one that stops this model emitting a tool call at all, which showed up as empty replies.
   *
   * Undefined means "whatever the harness decides". The panel still shows a number, because a
   * blank slider is unusable — it shows the EFFECTIVE one, read from the server.
   */
  const [touched, setTouched] = useState<Record<string, number>>({});
  const setKnob = (key: string, value: number) => setTouched((t) => ({ ...t, [key]: value }));
  /**
   * Hands a knob back to the chain.
   *
   * Switching persona deliberately does NOT clear what you moved — an explicit act should not be
   * undone by picking a different name. But without a way back, one nudged slider silently follows
   * you across every persona you try, and the panel would say `you` while you believed you were
   * running the persona as written.
   */
  const releaseKnob = (key: string) => setTouched(({ [key]: _dropped, ...rest }) => rest);
  const [thoughtSensitivity, setThoughtSensitivity] = useState<'low' | 'medium' | 'high'>('medium');
  const [ngramCap, setNgramCap] = useState(5);
  const [failureThreshold, setFailureThreshold] = useState(0.85);
  const [form, setForm] = useState({ name: '', baseUrl: '', model: '', apiKey: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const { data: models, isLoading } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    refetchInterval: 30000,
  });

  /** What the harness is actually set to, so the panel reflects reality rather than invention. */
  const { data: harness } = useQuery<{
    effective?: { key: string; value: unknown; source?: 'harness' | 'adopted' }[];
  }>({
    queryKey: profileKeys.config(),
    queryFn: getConfig,
    staleTime: 60_000,
  });
  /**
   * The value in force for a knob, resolved the way the SERVER resolves it.
   *
   *   adopted profile → chosen persona → what you moved
   *
   * The persona layer is the one that was missing: picking "Coder" applies its temperature on the
   * server and the panel went on showing the profile's, so a setting that was genuinely in force
   * looked like it had been ignored. A panel that disagrees with the request it describes is worse
   * than no panel.
   */
  const knob = (key: string, fallback: number): number => {
    if (touched[key] !== undefined) return touched[key]!;
    const persona = personas?.find((p) => p.id === personaId)?.overrides?.[key];
    if (typeof persona === 'number') return persona;
    const live = harness?.effective?.find((e) => e.key === key)?.value;
    return typeof live === 'number' ? live : fallback;
  };

  /** Where the displayed value came from, so a number is never just a number. */
  const knobSource = (key: string): string => {
    if (touched[key] !== undefined) return 'you';
    if (personas?.find((p) => p.id === personaId)?.overrides?.[key] !== undefined) return 'persona';
    return harness?.effective?.find((e) => e.key === key)?.source === 'adopted' ? 'adopted' : 'built-in';
  };

  const { data: personas } = useQuery<{
    id: string; name: string; description?: string; overrides?: Record<string, unknown>;
    /** Only `mcp` is read here — the composer says which services this persona can call. */
    scope?: { mcp?: string[] };
  }[]>({
    queryKey: personaKeys.list(),
    queryFn: listPersonas,
  });

  /** Resolved once so the composer and the request cannot disagree about who is answering. */
  const activePersona = personas?.find((p) => p.id === personaId);

  const addEndpoint = useMutation({
    mutationFn: () => addModelEndpoint(form),
    onSuccess: () => {
      setForm({ name: '', baseUrl: '', model: '', apiKey: '' });
      setFormError(null);
      qc.invalidateQueries({ queryKey: ['models'] });
    },
    // The backend's refusal reasons are specific (which address range, why) and are the only useful
    // guidance a user gets here, so surface them rather than a generic failure.
    onError: (e: unknown) => setFormError(errorMessage(e)),
  });

  const removeEndpoint = useMutation({
    mutationFn: (id: string) => removeModelEndpoint(id),
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

  /**
   * Keep the newest message in view.
   *
   * ── WHY A CALLBACK REF AND AN OBSERVER, NOT `useEffect([messages])` ──
   * That is what this was, and it silently never ran. Measured in the browser: on opening an
   * existing branch the effect fired twice with `scrollRef.current === null` and the container not
   * yet in the document, then never again — so a saved conversation opened scrolled to its FIRST
   * turn with everything after it below the fold, which reads as "the history isn't there".
   *
   * It never re-ran because TanStack Query does structural sharing: a refetch returning deep-equal
   * data hands back the SAME array, so `[messages]` is referentially stable and the effect has no
   * reason to fire again. The one chance it had, it took too early.
   *
   * A callback ref fires exactly when the node attaches, whenever that turns out to be, and a
   * MutationObserver covers everything that changes the content's height afterwards — a turn being
   * added, markdown laying out, tokens streaming into the last message. Neither depends on guessing
   * a render order, which is what the previous version got wrong.
   */
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
    // Re-pin only while the reader is at the bottom. Yanking someone back down while they are
    // reading earlier turns is worse than the problem this fixes.
    const mo = new MutationObserver(() => { if (pinnedRef.current) pin(); });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    observerRef.current = mo;
  }, [pin]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  /**
   * Opening a different conversation always jumps to its latest turn, even though the container
   * itself never unmounts — switching branches is the case the old code got wrong.
   */
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
      // `openChatStream` owns the transport and the error shape; the CONTROLLER stays here,
      // because aborting a turn is this component's stop button and the route aborts the upstream
      // model when the connection drops.
      const res = await openChatStream({
        modelId,
        messages: next,
        stream: true,
        branchId,
        mode: activeMode,
        // Omitted rather than sent empty: the route 404s an unknown persona, and "" is not one.
        ...(personaId ? { personaId } : {}),
        // Only knobs the user actually moved. Sending the panel's displayed values would put
        // them at the request layer and outrank the adopted profile on every turn.
        ...touched,
        thoughtMonitorSensitivity: thoughtSensitivity,
        ngramRepeatThreshold: ngramCap,
        failurePredictionThreshold: failureThreshold,
      }, controller.signal);

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
   * Sends a handed-off message once, when one arrives.
   *
   * Guarded by a ref rather than by the prop alone: `sendMessage` closes over `messages`, so the
   * effect re-runs as the reply streams in, and without the guard the review would be sent again
   * on every chunk.
   */
  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || autoSentRef.current === autoSend || streaming) return;
    autoSentRef.current = autoSend;
    // Cleared through the parent so a remount does not resend it.
    onAutoSent?.();
    void sendMessage(autoSend, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend]);

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
                {/*
                  * A persona carries the whole environment — image, network, tools, budget. Work
                  * with nobody assigned cannot run, so it says so here rather than failing later.
                  */}
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
      {/*
        * One line, not a toolbar row.
        *
        * The persona and model pickers were two full-height selects sitting permanently above the
        * transcript, and between them and the acceptance/delivery blocks the conversation was left
        * about 55% of the pane and clipped mid-sentence at the top. They are settings — read rarely,
        * changed rarely — so they state themselves in a line and open on demand.
        */}
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
                    {m.name} — {m.model || m.kind || (m.isMesh ? 'mesh' : 'endpoint')}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2.5">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--leaf-light)]">Sampling Controls</div>
              
              <p className="text-[10px] text-slate-500 leading-snug mb-1">
                {/* Said plainly: these are not this panel's numbers, they are the harness's — and
                    moving one is what makes it yours for this conversation. */}
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
        // Within a few pixels of the bottom counts as "following along" — scroll positions are
        // fractional, so an exact comparison would drop out of follow mode on its own.
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-2"
      >
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

          /**
           * System notices are events, not speech.
           *
           * Rendered inline in the transcript because that is where they belong chronologically —
           * a leaf failed AT that point in the conversation — but without an avatar, so nothing
           * reads as the assistant having said it.
           */
          if (m.notice) {
            return (
              <div key={i} className="flex gap-3">
                <div className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-600">
                  <Info size={15} />
                </div>
                <div className="flex-1 pt-1 min-w-0 text-[12px] text-slate-400 leading-relaxed
                                border-l-2 border-[var(--bark-600)] pl-3 py-1">
                  {/* The harness writes these with emphasis and check lists of its own, so a
                      failure notice was showing its own asterisks. */}
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
                {/*
                  * `.trim()`, because a whitespace-only string is truthy.
                  *
                  * Reasoning that was nothing but newlines still rendered — measured in the DOM as
                  * empty blocks 156px and 390px tall, since `pre-wrap` faithfully preserves every
                  * one of them. That is where the mysterious vertical gaps in a transcript came
                  * from: not spacing, but a disclosure holding nothing.
                  */}
                {reasoning?.trim() && (
                  <details className="mb-2 group" open={!prose}>
                    <summary className="text-[11px] uppercase tracking-widest text-slate-500 cursor-pointer select-none">
                      Thinking{!prose && streaming && i === messages.length - 1 ? '…' : ''}
                    </summary>
                    {/* Left as pre-wrap rather than markdown: deliberation is not written as
                        markdown, and its indentation is often the only structure it has. */}
                    <div className="mt-1 text-[12px] text-slate-500 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--bark-600)] pl-3">
                      {reasoning.trim()}
                    </div>
                  </details>
                )}

                {/* Rendered as markdown, not printed as its own syntax. A table of five fields
                    used to arrive as rows of pipe characters — the better the model formatted an
                    answer, the worse it read. */}
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

      {/*
        Who is answering, next to where you type.
        ── WHY THIS IS HERE AND NOT ONLY IN THE SETTINGS PANEL ──
        The selector lived in the drawer beside the model picker, and its default is "No persona" —
        so the common case was a conversation with nobody in particular, shown nowhere. Asked which
        persona they were talking to on a branch, the answer was usually "none", and nothing on
        screen said so.
        It matters more now than it used to: a persona decides which MCP servers the conversation
        can call, so "no persona" is also "no services", and that is invisible at the moment you are
        wondering why the model cannot reach one.
      */}
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
