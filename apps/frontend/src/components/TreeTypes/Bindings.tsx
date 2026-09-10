import { Plus, Trash2 } from 'lucide-react';
import { card, field, label, type TreeType, type PersonaEgressRule } from './shared.js';

const parsePorts = (s: string): number[] | undefined => {
  const ports = s.split(',').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return ports.length ? ports : undefined;
};

export function Bindings({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const bindings = value.defaultBindings ?? [];
  const egress = value.egress ?? [];
  const env = value.env ?? [];

  return (
    <div className="space-y-6">
      <section>
        <label className={label}>Default service bindings</label>
        <p className="text-[11px] text-slate-500 mb-2">Names of the bindings every tree of this type gets by default (e.g. "gitea").</p>
        <div className="flex flex-wrap gap-2 mb-2">
          {bindings.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bark-900)] border border-[var(--bark-600)] text-[12px] text-slate-300">
              {b}
              <button type="button" onClick={() => onChange({ defaultBindings: bindings.filter((_, j) => j !== i) })} className="text-slate-500 hover:text-red-400 cursor-pointer">
                <Trash2 size={11} />
              </button>
            </span>
          ))}
        </div>
        <AddRow placeholder="binding name" onAdd={(name) => onChange({ defaultBindings: [...bindings, name] })} />
      </section>

      <section>
        <label className={label}>Extra egress</label>
        <p className="text-[11px] text-slate-500 mb-2">Network reachability beyond what the default bindings already imply.</p>
        <div className="space-y-2">
          {egress.map((rule, i) => (
            <div key={i} className={`${card} p-3 flex items-center gap-2`}>
              <select
                className={`${field} w-auto`}
                value={rule.cidr !== undefined ? 'cidr' : 'namespace'}
                onChange={(e) => {
                  const next = [...egress];
                  next[i] = e.target.value === 'cidr'
                    ? { cidr: '', ports: rule.ports }
                    : { namespace: '', ports: rule.ports };
                  onChange({ egress: next });
                }}
              >
                <option value="cidr">CIDR</option>
                <option value="namespace">Namespace</option>
              </select>
              <input
                className={field}
                value={rule.cidr ?? rule.namespace ?? ''}
                placeholder={rule.cidr !== undefined ? '10.0.0.0/8' : 'namespace'}
                onChange={(e) => {
                  const next = [...egress];
                  next[i] = rule.cidr !== undefined ? { ...rule, cidr: e.target.value } : { ...rule, namespace: e.target.value };
                  onChange({ egress: next });
                }}
              />
              <input
                className={`${field} w-40`}
                placeholder="ports (comma-sep)"
                value={rule.ports?.join(', ') ?? ''}
                onChange={(e) => {
                  const next = [...egress];
                  next[i] = { ...rule, ports: parsePorts(e.target.value) };
                  onChange({ egress: next });
                }}
              />
              <button type="button" onClick={() => onChange({ egress: egress.filter((_, j) => j !== i) })} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onChange({ egress: [...egress, { cidr: '' } as PersonaEgressRule] })}
          className="mt-2 flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer"
        >
          <Plus size={13} /> Add egress rule
        </button>
      </section>

      <section>
        <label className={label}>Environment variables</label>
        <p className="text-[11px] text-slate-500 mb-2">Fixed env vars every leaf of this type runs with.</p>
        <div className="space-y-2">
          {env.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={`${field} font-mono`} placeholder="NAME" value={e.name}
                onChange={(ev) => onChange({ env: env.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) })}
              />
              <input
                className={field} placeholder="value" value={e.value}
                onChange={(ev) => onChange({ env: env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) })}
              />
              <button type="button" onClick={() => onChange({ env: env.filter((_, j) => j !== i) })} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onChange({ env: [...env, { name: '', value: '' }] })}
          className="mt-2 flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer"
        >
          <Plus size={13} /> Add env var
        </button>
      </section>
    </div>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (value: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        className={`${field} max-w-xs`}
        placeholder={placeholder}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === 'Enter' && el.value.trim()) {
            onAdd(el.value.trim());
            el.value = '';
          }
        }}
      />
      <span className="text-[11px] text-slate-600">Press Enter to add</span>
    </div>
  );
}

export default Bindings;
