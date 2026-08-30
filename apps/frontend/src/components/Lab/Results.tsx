import { Fragment, useState } from 'react';
import {
  ChevronRight, ChevronDown, CheckCircle2, XCircle, AlertTriangle,
} from 'lucide-react';
import {
  tally, useExperimentDetail,
  type AgentRequest, type AgentStep, type ConversationMessage,
  type ResultSummary, type VariantResult,
} from './shared';
import { PromoteConfirm } from './Promote';

export function Results({ results, tasks, variants, openResult, setOpenResult, scope, onPromoted,
}: {
  results: ResultSummary[];
  tasks: { id: string; name: string }[];
  variants: { label: string }[];
  openResult: string | null;
  setOpenResult: (v: string | null) => void;
  scope: string;
  onPromoted: () => void;
}) {
  const [promoting, setPromoting] = useState<string | null>(null);

  const expanded = openResult?.startsWith(`${scope}:`) ?? false;
  const { data: detail, isPending: detailPending } = useExperimentDetail(scope, expanded);
  const runsOf = (predicate: (r: ResultSummary) => boolean) => results.filter(predicate);
  
  const suite = variants.map((v) => ({ label: v.label, t: tally(runsOf((r) => r.label === v.label)) }));

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-slate-500 text-[10px] uppercase tracking-widest">
              <th className="text-left font-medium pb-2">Variant</th>
              <th className="text-right font-medium pb-2">Verified</th>
              <th className="text-right font-medium pb-2">Claimed</th>
              <th className="text-right font-medium pb-2">Steps</th>
              <th className="text-right font-medium pb-2">Tokens</th>
              <th className="text-right font-medium pb-2">Time</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {suite.map(({ label, t }) => {
              const lying = t.claimed > t.verified;
              const dash = (n: number, render: (v: number) => string) =>
                (t.attempted ? render(n) : '—');
              return (
                <Fragment key={label}>
                <tr className="border-t border-[var(--bark-700)]">
                  <td className="py-2 text-slate-300 font-mono">
                    {label}
                    {t.errored > 0 && (
                      <span className="text-amber-400 ml-2 font-sans text-[11px]">
                        {t.errored} didn't run
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <span className={t.attempted && t.verified === t.attempted ? 'text-[var(--leaf-light)]' : 'text-red-400'}>
                      {t.verified}/{t.attempted}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    <span className={lying ? 'text-amber-400 font-semibold' : 'text-slate-500'}>
                      {t.claimed}/{t.attempted}
                      {lying && <AlertTriangle size={11} className="inline ml-1 mb-0.5" />}
                    </span>
                  </td>
                  <td className="py-2 text-right text-slate-400">{dash(t.steps, String)}</td>
                  <td className="py-2 text-right text-slate-400">{dash(t.tokens, (v) => v.toLocaleString())}</td>
                  <td className="py-2 text-right text-slate-400">{dash(t.ms, (v) => `${Math.round(v / 1000)}s`)}</td>
                  <td className="py-2 pl-3 text-right">
                    {t.attempted > 0 && (
                      <button
                        onClick={() => setPromoting(promoting === label ? null : label)}
                        title="Adopt this configuration as the default"
                        className="text-[11px] text-slate-500 hover:text-[var(--leaf-light)]"
                      >
                        Promote
                      </button>
                    )}
                  </td>
                </tr>
                {promoting === label && (
                  <tr>
                    <td colSpan={7}>
                      <PromoteConfirm
                        experimentId={scope}
                        label={label}
                        onDone={() => { setPromoting(null); onPromoted(); }}
                        onCancel={() => setPromoting(null)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-slate-500 text-[10px] uppercase tracking-widest">
              <th className="text-left font-medium pb-2">Task</th>
              {variants.map((v) => (
                <th key={v.label} className="text-right font-medium pb-2 font-mono normal-case tracking-normal">
                  {v.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const forTask = runsOf((r) => r.taskId === task.id);
              const cells = variants.map((v) => ({
                label: v.label,
                t: tally(forTask.filter((r) => r.label === v.label)),
              }));
              const scored = cells.filter((c) => c.t.attempted > 0);
              const rates = new Set(scored.map((c) => c.t.verified / c.t.attempted));
              const uninformative = scored.length > 1 && rates.size === 1;
              const allFailed = scored.length > 0 && scored.every((c) => c.t.verified === 0);
              const openCell = cells.find((c) => openResult === `${scope}:${task.id}:${c.label}`);

              return (
                <Fragment key={task.id}>
                  <tr className="border-t border-[var(--bark-700)]">
                    <td className="py-2 pr-3 text-slate-300">
                      <span className="align-middle">{task.name}</span>
                      {uninformative && !allFailed && (
                        <span className="ml-2 text-[10px] text-slate-600 align-middle">no signal — all tied</span>
                      )}
                      {allFailed && (
                        <span className="ml-2 text-[10px] text-amber-400 align-middle">
                          every variant failed — check the task
                        </span>
                      )}
                    </td>
                    {cells.map(({ label, t }) => {
                      const key = `${scope}:${task.id}:${label}`;
                      const open = openResult === key;
                      const tone = !t.runs ? 'text-slate-600'
                        : t.verified === t.runs ? 'text-[var(--leaf-light)]'
                        : t.verified === 0 ? 'text-red-400'
                        : 'text-amber-400';
                      return (
                        <td key={label} className="py-1 text-right">
                          <button
                            disabled={!t.runs}
                            onClick={() => setOpenResult(open ? null : key)}
                            title={t.runs === 0
                              ? 'not run yet'
                              : t.attempted
                                ? `${label} — ${t.verified} of ${t.attempted} verified`
                                  + (t.runs > t.attempted ? ` (${t.runs - t.attempted} never completed)` : '')
                                : `${label} — ${t.runs} run${t.runs === 1 ? '' : 's'} never completed`}
                            className={`px-2 py-1 rounded font-mono ${tone} ${
                              open ? 'bg-[var(--bark-700)]' : t.runs ? 'hover:bg-[var(--bark-700)]/60' : ''
                            }`}
                          >
                            {t.attempted ? `${t.verified}/${t.attempted}` : t.runs ? '!' : '·'}
                            {t.claimed > t.verified && (
                              <AlertTriangle size={10} className="inline ml-1 mb-0.5 text-amber-400" />
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                  {openCell && (
                    <tr className="bg-[var(--bark-900)]/40">
                      <td colSpan={variants.length + 1} className="px-3 py-2">
                        <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-2">
                          {task.name} · {openCell.label}
                        </p>
                        {detailPending && <p className="text-[11px] text-slate-500">Loading the run…</p>}
                        {(detail?.results ?? [])
                          .filter((r) => r.taskId === task.id && r.label === openCell.label)
                          .map((r, i) => <RunDetail key={i} result={r} />)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SentToModel({ request }: { request: AgentRequest }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Sent to the model · {request.systemPrompt.length} chars · tools: {request.tools.join(', ')}
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          <div>
            <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">System prompt</p>
            <pre className="text-[10px] text-slate-400 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto bg-[var(--bark-900)]/60 rounded p-2">
              {request.systemPrompt}
            </pre>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">First user turn</p>
            <pre className="text-[10px] text-slate-400 whitespace-pre-wrap">{request.kickoff}</pre>
          </div>
          <Knobs request={request} />

          <div>
            <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">
              Tools offered ({request.tools.length})
            </p>
            <div className="space-y-1">
              {request.tools.map((t) => (
                <div key={t.name}>
                  <code className="text-[10px] text-[var(--leaf-light)]">{t.name}</code>
                  <p className="text-[10px] text-slate-500 leading-snug">{t.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">Raw request body</p>
            <pre className="text-[10px] text-slate-500 whitespace-pre-wrap break-all max-h-40 overflow-y-auto bg-[var(--bark-900)]/60 rounded p-2">
              {JSON.stringify(request.parameters, null, 1)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Knobs({ request }: { request: AgentRequest }) {
  const sent = request.parameters ?? {};
  const dropped = new Set(request.unsupported ?? []);
  /**
   * Every value came from one place — the pack the run was configured by — so a row says which pack
   * rather than which layer. `ranAs` carries that pack's values as they were when the run started,
   * which is what makes a finished run readable after the pack has moved on.
   */
  const from = request.ranAs ? `pack "${request.ranAs.slug}"` : 'the pack';

  const wire = Object.keys(sent).filter((k) => k !== 'messages' && k !== 'tools' && k !== 'stream'
    && k !== 'stream_options' && k !== 'model');
  const rows = [
    ...wire.map((key) => ({ key, value: sent[key], source: from })),
    ...[...dropped].map((key) => ({ key, value: undefined, source: 'DROPPED — wrong engine' })),
    ...(request.loop
      ? [
          { key: 'maxSteps', value: request.loop.maxSteps, source: from },
          { key: 'think', value: request.loop.think, source: from },
          { key: 'maxToolResultChars', value: request.loop.toolResultCap, source: from },
        ]
      : []),
  ];

  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">
        Knobs{request.model ? ` · ${request.model}` : ''}
      </p>
      <table className="w-full text-[10px]">
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.key}-${r.source}`}>
              <td className="py-0.5 pr-3 font-mono text-slate-400 align-top">{r.key}</td>
              <td className="py-0.5 pr-3 font-mono text-[var(--leaf-light)] align-top break-all">
                {typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value)}
              </td>
              <td className={`py-0.5 align-top whitespace-nowrap ${
                r.source === 'override' ? 'text-amber-400'
                  : r.source.startsWith('DROPPED') ? 'text-red-400'
                  : 'text-slate-600'
              }`}>
                {r.source}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Conversation({ messages }: { messages: ConversationMessage[] }) {
  const [open, setOpen] = useState(false);

  const TONE: Record<string, string> = {
    system: 'text-slate-500',
    user: 'text-slate-300',
    assistant: 'text-[var(--leaf-light)]',
    tool: 'text-amber-400',
  };

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Full conversation · {messages.length} messages
      </button>
      {open && (
        <div className="mt-1 space-y-2 max-h-[32rem] overflow-y-auto">
          {messages.map((m, i) => (
            <div key={i} className="bg-[var(--bark-900)]/60 rounded p-2">
              <div className="flex items-baseline gap-2 mb-1">
                <span className={`text-[9px] uppercase tracking-widest ${TONE[m.role] ?? 'text-slate-500'}`}>
                  {m.role}
                </span>
                {m.name && <span className="text-[9px] text-slate-600 font-mono">{m.name}</span>}
                {m.truncated && <span className="text-[9px] text-amber-400">truncated</span>}
                <span className="ml-auto text-[9px] text-slate-700">{m.content.length} chars</span>
              </div>
              {m.content && (
                <pre className="text-[10px] text-slate-400 whitespace-pre-wrap leading-relaxed">
                  {m.content}
                </pre>
              )}
              {m.toolCalls?.map((c, j) => (
                <div key={j} className="mt-1">
                  <span className="text-[10px] font-mono text-[var(--leaf-light)]">{c.name}</span>
                  <pre className="text-[10px] text-slate-500 whitespace-pre-wrap break-all">{c.arguments}</pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RunDetail({ result: r }: { result: VariantResult }) {
  return (
    <div className="flex items-start gap-2 mb-3 last:mb-0">
      {r.verified
        ? <CheckCircle2 size={13} className="text-[var(--leaf-light)] mt-0.5 shrink-0" />
        : <XCircle size={13} className="text-red-400 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        {r.error
          ? <p className="text-[11px] text-red-400">{r.error}</p>
          : <p className="text-[11px] text-slate-400">{r.summary}</p>}
        {r.expected && (
          <p className="text-[10px] text-slate-500 mt-1">
            <span className="text-slate-600">expected: </span>
            <code className="font-mono">{r.expected.verifyCommand}</code>
            <span className="text-slate-600"> → exit 0</span>
          </p>
        )}
        {r.verifyOutput && (
          <pre className="text-[10px] text-slate-500 mt-1 whitespace-pre-wrap">
            actual (exit {r.verifyExitCode}): {r.verifyOutput.slice(-400)}
          </pre>
        )}
        {r.usedDedicatedTool !== undefined && (
          <div className="mt-1.5 flex items-center gap-2">
            {r.usedDedicatedTool ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--leaf-dark)]/40 border border-[var(--leaf-light)]/40 text-[var(--leaf-light)] text-[10px] font-mono font-medium">
                <CheckCircle2 size={11} /> Dedicated Tool Invoked: {r.toolsUsed?.filter(t => !['run_command','write_file','read_file','finish','ls','cd','write','read','cat'].includes(t)).join(', ') || 'Yes'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/40 border border-amber-500/40 text-amber-300 text-[10px] font-mono font-medium">
                <AlertTriangle size={11} /> Dedicated Tool Bypassed (Bash Fallback)
              </span>
            )}
          </div>
        )}

        {r.toolsUsed && r.toolsUsed.length > 0 && (
          <div className="mt-1 text-[10px] text-slate-400 font-mono flex flex-wrap items-center gap-1">
            <span className="text-slate-500">Tools executed ({r.toolsUsed.length}): </span>
            {r.toolsUsed.map((t) => (
              <span key={t} className="bg-[var(--bark-800)] text-slate-300 px-1.5 py-0.5 rounded text-[10px]">
                {t}
              </span>
            ))}
          </div>
        )}

        {r.request && <SentToModel request={r.request} />}
        {r.conversation?.length ? <Conversation messages={r.conversation} /> : null}
        {r.transcript.length > 0 && (
          <p className="text-[10px] text-slate-600 mt-1 font-mono truncate">
            {r.transcript.join(' · ')}
          </p>
        )}
        {r.trace && r.trace.length > 0 && <Trace steps={r.trace} />}
      </div>
    </div>
  );
}

function Trace({ steps }: { steps: AgentStep[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="mt-2 border-l-2 border-[var(--bark-600)] pl-2">
      {steps.map((s) => {
        const isOpen = open === s.step;
        return (
          <div key={s.step} className="mb-1">
            <button
              onClick={() => setOpen(isOpen ? null : s.step)}
              className="flex items-center gap-2 text-[10px] text-slate-500 hover:text-slate-300 w-full text-left"
            >
              {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <span className="font-mono">step {s.step}</span>
              {s.reasoning && <span className="text-[var(--leaf-light)]">thought {s.reasoning.length}c</span>}
              <span className="truncate">
                {s.toolCalls.map((c) => c.name).join(', ') || (
                  s.content ? <span className="text-slate-300">prose: "{s.content.slice(0, 60)}…"</span> : <span className="text-amber-400">no tool call</span>
                )}
              </span>
              <span className="ml-auto shrink-0">{s.tokens.toLocaleString()}t</span>
            </button>
            {isOpen && (
              <div className="ml-3 mt-1 space-y-2">
                {s.reasoning && (
                  <div>
                    <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">Reasoning</p>
                    <pre className="text-[10px] text-slate-400 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto bg-[var(--bark-900)]/60 rounded p-2">
                      {s.reasoning}
                    </pre>
                  </div>
                )}
                {s.content && (
                  <div>
                    <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">Said</p>
                    <pre className="text-[10px] text-slate-400 whitespace-pre-wrap">{s.content}</pre>
                  </div>
                )}
                {s.toolCalls.map((c, i) => (
                  <div key={i}>
                    <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5">{c.name}</p>
                    <pre className="text-[10px] text-[var(--leaf-light)] whitespace-pre-wrap break-all">{c.arguments}</pre>
                    {s.toolResults[i] && (
                      <pre className="text-[10px] text-slate-500 whitespace-pre-wrap break-all mt-0.5">
                        → {s.toolResults[i]!.result}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
