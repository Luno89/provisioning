import { useState } from 'react';
import { Minus, Check, ChevronRight } from 'lucide-react';
import {
  groupTools, groupState, toggleGroup, toggleTool, unrunnable,
  type GroupableTool, type GroupState,
} from '../lib/tool-groups';

/**
 * Every tool a pack may be granted, as one list of collapsed groups.
 *
 * This was nine boxes in a three-column grid, each scrolling separately, so you could see neither
 * a whole category nor all the categories. Collapsed, every category fits on one screen with its
 * grant count, and granting a whole one is a single press that needs no expanding.
 *
 * The box and the name are separate targets on purpose: expanding a group to see what is in it
 * must not change what it grants.
 *
 * Every tool is grantable. A grant is the authority for what a run is offered, so nothing here
 * refuses one -- but a tool this pack has no way to run is marked, because the alternative is
 * finding out from a model that called it.
 */
export function ToolGrantList<T extends GroupableTool>({
  tools, selected, onChange, hasSandbox = true,
}: {
  tools: T[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Whether this pack has a workspace. Without one, the sandbox tools cannot run for it. */
  hasSandbox?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = groupTools(tools);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="border border-[var(--bark-800,#1b2620)] rounded-md bg-[var(--bark-950,#090d0b)] max-h-[22rem] overflow-y-auto divide-y divide-[var(--bark-800,#1b2620)]">
      {groups.map((group) => {
        const state: GroupState = groupState(group.tools, selected);
        const chosen = group.tools.filter((t) => selected.includes(t.name)).length;
        const isOpen = expanded.has(group.key);

        return (
          <div key={group.key}>
            <div className="flex items-center hover:bg-[var(--bark-900,#111814)] transition-colors">
              <button
                type="button"
                onClick={() => onChange(toggleGroup(selected, group.tools))}
                aria-label={`${state === 'all' ? 'Revoke' : 'Grant'} all ${group.label} tools`}
                title={state === 'all'
                  ? `Revoke all ${group.tools.length} ${group.label} tools`
                  : `Grant all ${group.tools.length} ${group.label} tools`}
                className="pl-3 pr-2 py-2 cursor-pointer"
              >
                <span
                  className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${
                    state === 'none'
                      ? 'border-[var(--bark-700,#24332b)] bg-[var(--bark-950,#090d0b)]'
                      : 'border-emerald-500 bg-emerald-600 text-white'
                  }`}
                >
                  {state === 'all' && <Check size={10} strokeWidth={3} />}
                  {state === 'some' && <Minus size={10} strokeWidth={3} />}
                </span>
              </button>

              <button
                type="button"
                onClick={() => toggleExpanded(group.key)}
                aria-expanded={isOpen}
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${group.label}`}
                className="flex-1 flex items-center gap-2 pr-3 py-2 text-left cursor-pointer min-w-0"
              >
                <span className="text-[11px] font-bold text-slate-200 truncate">{group.label}</span>
                <span className="ml-auto text-[10px] text-slate-500 font-mono shrink-0">
                  {chosen}/{group.tools.length}
                </span>
                <ChevronRight
                  size={12}
                  className={`text-slate-500 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
              </button>
            </div>

            {isOpen && (
              <div className="pb-1 bg-[var(--bark-900,#111814)]/40">
                {group.tools.map((t) => {
                  const isChecked = selected.includes(t.name);
                  const warning = isChecked ? unrunnable(t, hasSandbox) : undefined;
                  return (
                    <label
                      key={t.name}
                      className="flex items-start gap-2 pl-8 pr-3 py-1 text-[11px] text-slate-300 cursor-pointer hover:text-emerald-300 group"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onChange(toggleTool(selected, t.name))}
                        className="mt-0.5 rounded border-[var(--bark-700,#24332b)] bg-[var(--bark-900,#111814)] text-emerald-500 focus:ring-0 shrink-0"
                      />
                      <span className="min-w-0">
                        <span className="font-mono block truncate">{t.name}</span>
                        {t.description && (
                          <span className="block text-[10px] text-slate-500 group-hover:text-slate-400 leading-snug line-clamp-2">
                            {t.description}
                          </span>
                        )}
                        {warning && (
                          <span className="block text-[10px] text-amber-400/90 leading-snug" role="note">
                            {warning}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {groups.length === 0 && (
        <p className="text-[11px] text-slate-500 px-3 py-4">No tools in the registry.</p>
      )}
    </div>
  );
}

export default ToolGrantList;
