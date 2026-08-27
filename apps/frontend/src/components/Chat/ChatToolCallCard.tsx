import { useState } from 'react';
import { Terminal, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react';

export interface ToolCallData {
  id: string;
  name: string;
  args?: string | undefined;
  ok?: boolean | undefined;
  digest?: string | undefined;
  running?: boolean | undefined;
}

export function ChatToolCallCard({ tool }: { tool: ToolCallData }) {
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
