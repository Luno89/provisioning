import {
  field, label, VALIDATION_CHECK_TYPES, K8S_PROBE_KINDS,
  type ValidationCheckDefinition, type ValidationCheckType, type CustomStepDefinition, type RecipeNode,
} from '../shared.js';
import { STEP_TYPE_LABELS, STEP_TYPE_HINTS, blankStep } from './stepTemplates.js';

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export function StepEditor({
  step, earlierNodes, customSteps, onChange,
}: {
  step: ValidationCheckDefinition;
  /** Nodes (leaves and groups/loops) visited earlier in the whole recipe's document order — the
   * only valid runIf targets, matching the backend's whole-tree runIf scope. */
  earlierNodes: RecipeNode[];
  customSteps: readonly CustomStepDefinition[];
  onChange: (patch: Partial<ValidationCheckDefinition>) => void;
}) {
  const patch = (p: Partial<ValidationCheckDefinition>) => onChange(p);
  const changeType = (type: ValidationCheckType) => {
    const template = blankStep(type, customSteps);
    onChange({ ...template, id: step.id, name: step.name || template.name });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Name</label>
          <input className={field} value={step.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div>
          <label className={label}>Type</label>
          <select className={field} value={step.type} onChange={(e) => changeType(e.target.value as ValidationCheckType)}>
            {VALIDATION_CHECK_TYPES.map((t) => (
              <option key={t} value={t} disabled={t === 'custom' && customSteps.length === 0}>
                {STEP_TYPE_LABELS[t]}{t === 'custom' && customSteps.length === 0 ? ' (none defined yet)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 -mt-1">{STEP_TYPE_HINTS[step.type]}</p>

      <div>
        <label className={label}>Description (optional)</label>
        <input className={field} value={step.description ?? ''} onChange={(e) => patch({ description: e.target.value || undefined })} />
      </div>

      <TypeFields step={step} customSteps={customSteps} onChange={patch} />

      <div className="grid grid-cols-3 gap-3 pt-2 border-t border-[var(--bark-700)]">
        <div>
          <label className={label}>Run only if</label>
          <select
            className={field}
            value={step.runIf ?? ''}
            onChange={(e) => patch({ runIf: e.target.value || undefined })}
          >
            <option value="">Always runs</option>
            {earlierNodes.map((n) => (
              <option key={n.id} value={n.id}>{n.name || n.id} passed</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Retries</label>
          <input
            className={field} type="number" min={0} value={step.retries ?? 0}
            onChange={(e) => patch({ retries: num(e.target.value) || undefined })}
          />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-[12px] text-slate-300">
            <input type="checkbox" checked={step.optional ?? false} onChange={(e) => patch({ optional: e.target.checked || undefined })} />
            Optional (failure doesn't block the recipe)
          </label>
        </div>
      </div>
    </div>
  );
}

function TypeFields({ step, customSteps, onChange }: {
  step: ValidationCheckDefinition;
  customSteps: readonly CustomStepDefinition[];
  onChange: (patch: Partial<ValidationCheckDefinition>) => void;
}) {
  switch (step.type) {
    case 'file-exists':
      return (
        <div>
          <label className={label}>Path</label>
          <input className={field} value={step.target ?? ''} onChange={(e) => onChange({ target: e.target.value })} />
        </div>
      );

    case 'content-matches':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Path</label>
            <input className={field} value={step.target ?? ''} onChange={(e) => onChange({ target: e.target.value })} />
          </div>
          <div>
            <label className={label}>Pattern (regex)</label>
            <input className={field} value={step.pattern ?? ''} onChange={(e) => onChange({ pattern: e.target.value })} />
          </div>
        </div>
      );

    case 'run-command':
      return (
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <div>
            <label className={label}>Command</label>
            <input className={field} value={step.command ?? ''} onChange={(e) => onChange({ command: e.target.value })} />
          </div>
          <div>
            <label className={label}>Timeout (ms)</label>
            <input className={field} type="number" value={step.timeoutMs ?? ''} onChange={(e) => onChange({ timeoutMs: num(e.target.value) })} />
          </div>
        </div>
      );

    case 'http-probe':
      return (
        <div className="grid grid-cols-[1fr_120px_140px] gap-3">
          <div>
            <label className={label}>URL</label>
            <input className={field} value={step.target ?? ''} onChange={(e) => onChange({ target: e.target.value })} />
          </div>
          <div>
            <label className={label}>Expected status</label>
            <input className={field} type="number" value={step.expectedStatus ?? 200} onChange={(e) => onChange({ expectedStatus: num(e.target.value) })} />
          </div>
          <div>
            <label className={label}>Timeout (ms)</label>
            <input className={field} type="number" value={step.timeoutMs ?? ''} onChange={(e) => onChange({ timeoutMs: num(e.target.value) })} />
          </div>
        </div>
      );

    case 'mcp-probe':
      return (
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <div>
            <label className={label}>MCP URL</label>
            <input className={field} value={step.target ?? ''} onChange={(e) => onChange({ target: e.target.value })} />
          </div>
          <div>
            <label className={label}>Timeout (ms)</label>
            <input className={field} type="number" value={step.timeoutMs ?? ''} onChange={(e) => onChange({ timeoutMs: num(e.target.value) })} />
          </div>
        </div>
      );

    case 'git-tracked':
      return (
        <div>
          <label className={label}>Path</label>
          <input className={field} value={step.target ?? ''} onChange={(e) => onChange({ target: e.target.value })} />
        </div>
      );

    case 'k8s-probe':
      return (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={label}>Kind</label>
            <select className={field} value={step.kind ?? 'pod'} onChange={(e) => onChange({ kind: e.target.value as typeof step.kind })}>
              {K8S_PROBE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Namespace</label>
            <input className={field} value={step.namespace ?? ''} onChange={(e) => onChange({ namespace: e.target.value })} />
          </div>
          <div>
            <label className={label}>Resource name</label>
            <input className={field} value={step.target ?? ''} onChange={(e) => onChange({ target: e.target.value })} />
          </div>
        </div>
      );

    case 'wait-for':
      return (
        <div className="space-y-3">
          <div>
            <label className={label}>Wraps</label>
            <select
              className={field}
              value={step.waitForType ?? 'http-probe'}
              onChange={(e) => onChange({ waitForType: e.target.value as typeof step.waitForType })}
            >
              {(['file-exists', 'content-matches', 'run-command', 'http-probe', 'mcp-probe', 'git-tracked', 'k8s-probe', 'custom'] as const).map((t) => (
                <option key={t} value={t} disabled={t === 'custom' && customSteps.length === 0}>{t}</option>
              ))}
            </select>
          </div>
          <TypeFields step={{ ...step, type: step.waitForType ?? 'http-probe' }} customSteps={customSteps} onChange={onChange} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Poll every (ms)</label>
              <input className={field} type="number" value={step.pollIntervalMs ?? 2000} onChange={(e) => onChange({ pollIntervalMs: num(e.target.value) })} />
            </div>
            <div>
              <label className={label}>Give up after (ms)</label>
              <input className={field} type="number" value={step.timeoutMs ?? 30000} onChange={(e) => onChange({ timeoutMs: num(e.target.value) })} />
            </div>
          </div>
        </div>
      );

    case 'custom': {
      const def = customSteps.find((d) => d.id === step.customStepId);
      return (
        <div className="space-y-3">
          <div>
            <label className={label}>Custom step type</label>
            <select
              className={field}
              value={step.customStepId ?? ''}
              onChange={(e) => {
                const next = customSteps.find((d) => d.id === e.target.value);
                onChange({
                  customStepId: e.target.value || undefined,
                  params: next ? Object.fromEntries(next.fields.map((f) => [f.key, f.defaultValue ?? ''])) : undefined,
                });
              }}
            >
              <option value="">Pick one…</option>
              {customSteps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {def?.description && <p className="text-[11px] text-slate-500 mt-1">{def.description}</p>}
          </div>
          {def?.fields.map((f) => (
            <div key={f.key}>
              <label className={label}>{f.label}</label>
              {f.kind === 'boolean' ? (
                <label className="flex items-center gap-2 text-[12px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={Boolean(step.params?.[f.key])}
                    onChange={(e) => onChange({ params: { ...step.params, [f.key]: e.target.checked } })}
                  />
                  {f.label}
                </label>
              ) : (
                <input
                  className={field}
                  type={f.kind === 'number' ? 'number' : 'text'}
                  value={String(step.params?.[f.key] ?? '')}
                  onChange={(e) => onChange({
                    params: { ...step.params, [f.key]: f.kind === 'number' ? num(e.target.value) ?? '' : e.target.value },
                  })}
                />
              )}
            </div>
          ))}
        </div>
      );
    }
  }
}

export default StepEditor;
