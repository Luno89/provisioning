import { useState } from 'react';
import { ChevronDown, ChevronRight, Brain, Sparkles } from 'lucide-react';

export default function ThoughtAccordion({
  thoughts,
  isThinking = false,
  defaultOpen = false,
}: {
  thoughts: string[];
  isThinking?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (thoughts.length === 0 && !isThinking) return null;

  return (
    <div className="w-full my-2 bg-[var(--bark-850,#161922)] rounded-xl border border-[var(--bark-700,#2a2e3d)] overflow-hidden text-xs shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3.5 py-2 flex items-center justify-between text-slate-300 hover:text-white hover:bg-[var(--bark-800,#1d212c)] transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {isThinking ? (
            <Sparkles size={14} className="text-amber-400 animate-spin" />
          ) : (
            <Brain size={14} className="text-[var(--leaf,#10b981)]" />
          )}
          <span className="font-semibold text-[11px] tracking-wide">
            {isThinking ? 'Thinking & Deliberating...' : 'Thought Process & Analysis'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
          <span>{open ? 'Hide' : 'Show'}</span>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </button>

      {open && (
        <div className="px-4 py-3 border-t border-[var(--bark-750,#222634)] bg-black/20 text-slate-300 space-y-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">
          {thoughts.map((thought, idx) => (
            <div key={idx} className="border-l-2 border-slate-600 pl-3 py-0.5">
              {thought}
            </div>
          ))}
          {isThinking && (
            <div className="flex items-center gap-1 text-amber-400/80 italic pt-1">
              <span className="animate-pulse">Analyzing problem constraints and formulating response...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
