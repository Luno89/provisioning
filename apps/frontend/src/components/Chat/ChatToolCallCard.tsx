import { useState } from 'react';
import { Terminal, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, FileText, ExternalLink, Bot } from 'lucide-react';
import type { Artifact, ChildSteps } from '@koala/agent-engine/procedure';
import { childView, type ChildRunView } from '../../lib/chat-unified-reducer.js';

export type FileArtifact = Extract<Artifact, { kind: 'file' }>;

export interface ToolCallData {
  id: string;
  name: string;
  args?: string | undefined;
  ok?: boolean | undefined;
  digest?: string | undefined;
  running?: boolean | undefined;
  artifacts?: Artifact[] | undefined;
  child?: ChildRunView | ChildSteps | undefined;
}

const LIVE_TAIL_CHARS = 400;

function ChildRun({ child, onOpenDocument }: { child: ChildRunView; onOpenDocument?: ((file: FileArtifact) => void) | undefined }) {
  const [shown, setShown] = useState<boolean | undefined>(undefined);
  const open = shown ?? child.running;
  const steps = child.tools.length;
  const failed = !child.running && child.outcome !== undefined && child.outcome !== 'ok';

  return (
    <div className="px-3 pb-2" aria-label={`What ${child.agentId} is doing`}>
      <button
        type="button"
        onClick={() => setShown(!open)}
        className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Bot size={11} className="shrink-0" />
        <span className="font-mono">{child.agentId}</span>
        <span>
          {child.running
            ? `working — ${steps} ${steps === 1 ? 'step' : 'steps'} so far`
            : `${failed ? `did not finish${child.reason ? `: ${child.reason}` : ''}` : 'finished'} — ${steps} ${steps === 1 ? 'step' : 'steps'}`}
        </span>
      </button>
      {open && (
        <div className="mt-1 ml-1.5 pl-2 border-l border-[var(--bark-800,#1b2620)]">
          {child.tools.map((tool) => (
            <ChatToolCallCard key={tool.id} tool={tool} onOpenDocument={onOpenDocument} />
          ))}
          {child.running && child.live && (
            <p className="mt-1 text-[11px] text-slate-400 whitespace-pre-wrap leading-relaxed">
              {child.live.length > LIVE_TAIL_CHARS ? `…${child.live.slice(-LIVE_TAIL_CHARS)}` : child.live}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ArtifactList({ artifacts, onOpenDocument }: { artifacts: Artifact[]; onOpenDocument?: ((file: FileArtifact) => void) | undefined }) {
  return (
    <ul className="px-3 pb-2 pt-0.5 space-y-0.5" aria-label="What it made">
      {artifacts.map((artifact) => (
        <li key={artifact.kind === 'file' ? `${artifact.workspace}:${artifact.path}` : artifact.url}>
          {artifact.kind === 'file' ? (
            <button
              type="button"
              onClick={() => onOpenDocument?.(artifact)}
              disabled={!onOpenDocument}
              title={artifact.path}
              className="flex items-center gap-1.5 text-[11.5px] text-emerald-300/90 hover:text-emerald-200 hover:underline font-mono truncate max-w-full disabled:no-underline disabled:text-slate-400"
            >
              <FileText size={11} className="shrink-0" />
              <span className="truncate">{artifact.path}</span>
            </button>
          ) : (
            <a
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-[11.5px] text-sky-300 hover:underline truncate"
            >
              <ExternalLink size={11} className="shrink-0" />
              <span className="truncate">{artifact.title ?? artifact.url}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ChatToolCallCard({ tool, onOpenDocument }: { tool: ToolCallData; onOpenDocument?: ((file: FileArtifact) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const isRunning = tool.running || (tool.ok === undefined && !tool.digest);
  const isOk = tool.ok === true || (!isRunning && tool.ok !== false);
  const hasDetails = Boolean(tool.args || tool.digest);

  return (
    <div className="my-1 rounded-md border border-[var(--bark-800,#1b2620)] bg-[var(--bark-900,#111814)]/60 text-xs overflow-hidden transition-all font-sans">
      <div
        onClick={() => hasDetails && setOpen(!open)}
        className={`flex items-center justify-between px-3 py-1.5 select-none ${
          hasDetails ? 'cursor-pointer hover:bg-[var(--bark-800,#1b2620)]/50' : ''
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0">
            {isRunning ? (
              <Loader2 size={12} className="animate-spin text-emerald-400" />
            ) : isOk ? (
              <CheckCircle2 size={12} className="text-emerald-400" />
            ) : (
              <XCircle size={12} className="text-red-400" />
            )}
          </span>

          <span className="font-medium text-slate-200 truncate flex items-center gap-1.5 font-mono text-[11.5px]">
            <Terminal size={11} className="text-slate-400 shrink-0" />
            <span>{tool.name}</span>
          </span>

          {isRunning ? (
            <span className="text-[10.5px] text-emerald-400/90 font-sans animate-pulse">
              running...
            </span>
          ) : (
            <span className="text-[10.5px] text-slate-500 font-sans">
              {isOk ? 'completed' : 'failed'}
            </span>
          )}
        </div>

        {hasDetails && (
          <div className="text-slate-400 hover:text-slate-200 ml-2 shrink-0">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </div>
        )}
      </div>

      {tool.artifacts && tool.artifacts.length > 0 && (
        <ArtifactList artifacts={tool.artifacts} onOpenDocument={onOpenDocument} />
      )}

      {tool.child && <ChildRun child={childView(tool.child)} onOpenDocument={onOpenDocument} />}

      {open && hasDetails && (
        <div className="px-3 pb-2.5 pt-1 border-t border-[var(--bark-800,#1b2620)] bg-black/20 space-y-2 text-xs leading-relaxed font-sans">
          {tool.args && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-0.5">
                Arguments
              </div>
              <pre className="p-2 rounded bg-[var(--bark-950,#090d0b)] text-slate-300 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap border border-[var(--bark-800,#1b2620)]">
                {tool.args}
              </pre>
            </div>
          )}

          {tool.digest && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-0.5">
                Output
              </div>
              <pre className="p-2 rounded bg-[var(--bark-950,#090d0b)] text-emerald-300/90 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto border border-[var(--bark-800,#1b2620)]">
                {tool.digest}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ChatToolCallCard;
