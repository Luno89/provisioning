import { Sprout, Terminal, Box, AlertTriangle } from 'lucide-react';
import { KoalaSpot } from '../Koala.js';

export interface StarterPrompt {
  label: string;
  icon: any;
  prompt: string;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    label: 'Propose Project Tree',
    icon: Sprout,
    prompt: 'Propose a new project architecture for our stack with full directory layout and services.',
  },
  {
    label: 'Inspect Infrastructure',
    icon: Terminal,
    prompt: 'Inspect the cluster capacity, running pods, and live infrastructure resources.',
  },
  {
    label: 'Propose App Spec',
    icon: Box,
    prompt: 'Propose a production-ready application spec for deploying a scalable microservice.',
  },
  {
    label: 'Fetch Diagnostics & Logs',
    icon: AlertTriangle,
    prompt: 'Check system logs and diagnostic events across our active services.',
  },
];

export function ChatHero({
  packName = 'Koala',
  onSelectPrompt,
  onOpenPersona,
}: {
  packName?: string;
  onSelectPrompt: (prompt: string) => void;
  onOpenPersona?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-4 max-w-2xl mx-auto space-y-5 font-sans">
      {/* Centered Koala Mascot */}
      <div
        className="cursor-pointer transition-opacity hover:opacity-80"
        onClick={onOpenPersona}
        title="Configure persona directives and tools"
      >
        <KoalaSpot size={64} mood="idle" />
      </div>

      <div className="space-y-1">
        <h2 className="text-base font-semibold text-slate-100">
          How can {packName} help today?
        </h2>
        <p className="text-xs text-slate-400 font-sans leading-normal max-w-sm mx-auto">
          Architecture design, cluster capacity, logs inspection, and full-stack provisioning.
        </p>
      </div>

      {/* 4 Interactive Starter Prompt Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full pt-1">
        {STARTER_PROMPTS.map((item, idx) => {
          const Icon = item.icon;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectPrompt(item.prompt)}
              className="group flex items-start gap-2.5 p-3 rounded-lg bg-[var(--bark-900,#111814)] border border-[var(--bark-800,#1b2620)] hover:border-slate-600 text-left transition-colors cursor-pointer"
            >
              <div className="p-1.5 rounded bg-[var(--bark-800,#1b2620)] text-slate-300 group-hover:text-emerald-300 transition-colors shrink-0 mt-0.5">
                <Icon size={14} />
              </div>
              <div className="space-y-0.5 min-w-0">
                <div className="text-xs font-medium text-slate-200 group-hover:text-white transition-colors">
                  {item.label}
                </div>
                <div className="text-[11px] text-slate-400 font-sans line-clamp-2 leading-snug">
                  {item.prompt}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ChatHero;
