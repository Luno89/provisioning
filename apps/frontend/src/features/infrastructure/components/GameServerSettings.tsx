import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react';
import { getAppSchema, type AppSetting, type AppSettingsSchema } from '../api/app-schemas';

interface Props {
  appType: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export default function GameServerSettings({ appType, value, onChange }: Props) {
  const [search, setSearch] = useState('');
  const [onlyModified, setOnlyModified] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ Server: true });

  const { data: schema, isLoading, error } = useQuery<AppSettingsSchema>({
    queryKey: ['app-schema', appType],
    queryFn: () => getAppSchema(appType),
    staleTime: Infinity,
  });

  const isModified = (s: AppSetting) => value[s.env] !== undefined && value[s.env] !== s.default;

  const visible = useMemo(() => {
    if (!schema) return [];
    const q = search.trim().toLowerCase();
    return schema.settings.filter((s) => {
      if (onlyModified && !isModified(s)) return false;
      if (!q) return true;
      return (
        s.label.toLowerCase().includes(q) ||
        s.env.toLowerCase().includes(q) ||
        s.key.toLowerCase().includes(q)
      );
    });
  }, [schema, search, onlyModified, value]);

  const byCategory = useMemo(() => {
    const m = new Map<string, AppSetting[]>();
    for (const s of visible) {
      if (!m.has(s.category)) m.set(s.category, []);
      m.get(s.category)!.push(s);
    }
    return m;
  }, [visible]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
        <Loader2 size={16} className="animate-spin" /> Loading settings schema…
      </div>
    );
  }
  if (error || !schema) {
    return (
      <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
        Couldn't load the settings schema for "{appType}".
      </div>
    );
  }

  const modifiedCount = schema.settings.filter(isModified).length;
  const sectionOpen = (cat: string) => (search.trim() || onlyModified ? true : !!expanded[cat]);

  const field = (s: AppSetting) => {
    const current = value[s.env] ?? s.default;
    const set = (v: string) => onChange({ ...value, [s.env]: v });
    const cls =
      'w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed';

    if (s.readonly) {
      return <input className={cls} value={current} disabled title="Managed by the platform" />;
    }
    if (s.secret) {
      return <input className={cls} type="password" placeholder="Leave blank to keep current" onChange={(e) => set(e.target.value)} />;
    }
    if (s.type === 'bool') {
      return (
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer py-2">
          <input
            type="checkbox"
            checked={current === 'true'}
            onChange={(e) => set(e.target.checked ? 'true' : 'false')}
            className="w-4 h-4 accent-blue-500"
          />
          {current === 'true' ? 'Enabled' : 'Disabled'}
        </label>
      );
    }
    if (s.type === 'enum') {
      return (
        <select className={cls} value={current} onChange={(e) => set(e.target.value)}>
          {(s.options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    }
    if (s.type === 'int' || s.type === 'float') {
      return (
        <input
          className={cls}
          type="number"
          value={current}
          min={s.min}
          max={s.max}
          step={s.step ?? (s.type === 'int' ? 1 : 'any')}
          onChange={(e) => set(e.target.value)}
        />
      );
    }
    return <input className={cls} value={current} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="space-y-4">
      <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
        <AlertTriangle className="text-amber-500 flex-shrink-0 mt-0.5" size={16} />
        <p className="text-[11px] text-slate-400 leading-relaxed">
          <strong className="text-amber-400">Saving restarts the server.</strong> Every connected
          player is disconnected and the world reloads. The server is unreachable for a minute or
          two while it comes back.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings…"
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <button
          onClick={() => setOnlyModified((v) => !v)}
          className={`px-3 py-2 rounded-xl text-xs font-bold transition-all ${
            onlyModified ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-800 text-slate-400 hover:text-slate-200'
          }`}
        >
          Modified ({modifiedCount})
        </button>
      </div>

      <div className="text-[11px] text-slate-500">
        Showing {visible.length} of {schema.settings.length} settings
      </div>

      {schema.categories
        .filter((cat) => byCategory.has(cat))
        .map((cat) => {
          const items = byCategory.get(cat)!;
          const catModified = items.filter(isModified).length;
          const open = sectionOpen(cat);
          return (
            <div key={cat} className="border border-slate-800 rounded-2xl overflow-hidden">
              <button
                onClick={() => setExpanded((e) => ({ ...e, [cat]: !e[cat] }))}
                className="w-full flex items-center justify-between px-4 py-3 bg-slate-900/60 hover:bg-slate-900 transition-all"
              >
                <span className="flex items-center gap-2 text-sm font-bold text-slate-200">
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {cat}
                  <span className="text-[10px] text-slate-500 font-normal">({items.length})</span>
                </span>
                {catModified > 0 && (
                  <span className="text-[10px] font-bold text-blue-400">{catModified} changed</span>
                )}
              </button>

              {open && (
                <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {items.map((s) => (
                    <div key={s.env}>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                          {isModified(s) && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" title="Changed from default" />}
                          {s.label}
                        </label>
                        {isModified(s) && !s.readonly && !s.secret && (
                          <button
                            onClick={() => onChange({ ...value, [s.env]: s.default })}
                            title={`Reset to ${s.default}`}
                            className="text-slate-600 hover:text-slate-300 transition-colors"
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                      </div>
                      {field(s)}
                      {s.help && <p className="text-[10px] text-slate-600 mt-1 leading-relaxed">{s.help}</p>}
                      {s.readonly && <p className="text-[10px] text-slate-600 mt-1">Managed by the platform.</p>}
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
