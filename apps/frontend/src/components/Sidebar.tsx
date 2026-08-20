import { Shield, FlaskConical, Trees, Trees as TreesIcon, ChevronDown, ChevronRight, Terminal, Cpu } from 'lucide-react';
import { Koala } from './Koala';

/**
 * The navigation, and the hierarchy it exists to state.
 *
 * ── WHY THE SHAPE IS WHAT IT IS ──
 * Koala is the product; everything else is infrastructure it runs on. Giving the harness top billing
 * and folding ten operational tabs into one Forest keeps that legible, instead of presenting eleven
 * equal choices and letting the reader work out which one matters.
 *
 * Koala IS the chat. The Grove sits under it as Projects: you arrive in a conversation and go to the
 * projects when you want to build. Personas and Lab are indented under Koala rather than listed
 * beside it, because tuning the harness is Koala's business and not the infrastructure's — Lab in
 * particular used to sit two levels down inside Forest, whose open state was not persisted, so
 * collapsing Forest made it vanish entirely.
 *
 * ── WHY IT IS A COMPONENT ──
 * It was 78 lines inside a 3,284-line App, whose single function held the hooks, every screen and
 * every modal. Nothing here needs App's state beyond the current view and two setters, so keeping it
 * there only made the file longer.
 */

export interface ForestTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

export default function Sidebar({
  view, setView, forestOpen, setForestOpen, forestTabs, onLogout,
}: {
  view: string;
  setView: (view: any) => void;
  forestOpen: boolean;
  setForestOpen: (update: (open: boolean) => boolean) => void;
  forestTabs: readonly ForestTab[];
  onLogout: () => void;
}) {
  /** Top-level entry: the product itself. */
  const primary = (active: boolean) =>
    `w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
      active ? 'bg-[var(--leaf-stem)] text-white' : 'text-slate-300 hover:bg-[var(--bark-700)]'}`;

  /** Indented entry: something belonging to the thing above it. */
  const nested = (active: boolean) =>
    `w-full flex items-center gap-2.5 pl-11 pr-3 py-2 rounded-xl text-[13px] transition-colors ${
      active ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`;

  return (
    <aside className="w-64 bg-[var(--bark-800)] border-r border-[var(--bark-600)] p-5 flex flex-col shadow-xl z-20">
      <div className="flex items-center gap-2.5 mb-8">
        <Koala size={34} mood="idle" />
        <div className="leading-none">
          <h1 className="text-lg font-bold tracking-tight">NO WRINKLES</h1>
          <p className="text-[10px] text-[var(--leaf)] tracking-widest uppercase mt-0.5">smooth brained ops</p>
        </div>
      </div>

      <nav className="space-y-1 flex-1 overflow-y-auto">
        <button onClick={() => setView('chat')} className={primary(view === 'chat')}>
          <Koala size={20} mood={view === 'chat' ? 'happy' : 'idle'} /> Koala
        </button>

        <button onClick={() => setView('grove')} className={nested(view === 'grove')}>
          <TreesIcon size={15} /> Projects
        </button>

        <button onClick={() => setView('personas')} className={nested(view === 'personas')}>
          <Shield size={15} className="text-[var(--leaf)]" /> Personas
        </button>

        <button onClick={() => setView('lab')} className={nested(view === 'lab')}>
          <FlaskConical size={15} className="text-[var(--leaf)]" /> Lab
        </button>

        <button onClick={() => setView('harness')} className={nested(view === 'harness')}>
          <Cpu size={15} className="text-[var(--leaf)]" /> Harness
        </button>

        <button
          onClick={() => setForestOpen((o) => !o)}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-[var(--bark-700)] transition-colors"
        >
          <Trees size={20} className="text-[var(--leaf)]" />
          <span className="flex-1 text-left">Forest</span>
          {forestOpen
            ? <ChevronDown size={14} className="text-slate-500" />
            : <ChevronRight size={14} className="text-slate-500" />}
        </button>

        {forestOpen && (
          <div className="ml-3 pl-3 border-l border-[var(--bark-600)] space-y-0.5">
            {forestTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setView(tab.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${
                  view === tab.id ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`}
              >
                <tab.icon size={15} /> {tab.label}
              </button>
            ))}
          </div>
        )}
      </nav>

      <button
        onClick={onLogout}
        className="w-full mt-4 mb-4 flex items-center gap-3 px-3 py-2.5 text-red-400/80 hover:bg-red-500/10 rounded-xl transition-all cursor-pointer text-[13px] font-semibold"
      >
        Log Out
      </button>
      <div className="pt-4 border-t border-[var(--bark-600)] flex items-center gap-2 text-slate-600 text-[10px] uppercase font-black tracking-widest">
        <Terminal size={13} /> <span>Local Ops Active</span>
      </div>
    </aside>
  );
}
