import { field, label, LOOP_TYPES, type RecipeGroup, type RecipeLoop, type LoopType, type RecipeNode } from '../shared.js';
import { LOOP_TYPE_LABELS, LOOP_TYPE_HINTS } from './stepTemplates.js';

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export interface GroupLoopPatch {
  name?: string;
  runIf?: string | undefined;
  optional?: boolean | undefined;
  loopType?: LoopType;
  maxIterations?: number | undefined;
  timeoutMs?: number | undefined;
  itemsCommand?: string | undefined;
}

export function GroupLoopEditor({ node, earlierNodes, onChange }: {
  node: RecipeGroup | RecipeLoop;
  earlierNodes: RecipeNode[];
  onChange: (patch: GroupLoopPatch) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className={label}>Name</label>
        <input className={field} value={node.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>

      {node.containerType === 'loop' && (
        <>
          <div>
            <label className={label}>Loop kind</label>
            <select className={field} value={node.loopType} onChange={(e) => onChange({ loopType: e.target.value as LoopType })}>
              {LOOP_TYPES.map((t) => <option key={t} value={t}>{LOOP_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <p className="text-[11px] text-slate-500 -mt-1">{LOOP_TYPE_HINTS[node.loopType]}</p>

          {(node.loopType === 'count' || node.loopType === 'until') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>{node.loopType === 'count' ? 'Repeat count' : 'Max attempts'}</label>
                <input
                  className={field} type="number" min={1} value={node.maxIterations ?? ''}
                  onChange={(e) => onChange({ maxIterations: num(e.target.value) })}
                />
              </div>
              {node.loopType === 'until' && (
                <div>
                  <label className={label}>Overall timeout (ms, optional)</label>
                  <input
                    className={field} type="number" value={node.timeoutMs ?? ''} placeholder="No overall limit"
                    onChange={(e) => onChange({ timeoutMs: num(e.target.value) })}
                  />
                </div>
              )}
            </div>
          )}

          {node.loopType === 'forEach' && (
            <div className="grid grid-cols-[1fr_140px] gap-3">
              <div>
                <label className={label}>Items command</label>
                <input
                  className={field} value={node.itemsCommand ?? ''} placeholder="e.g. ls docs/*.md"
                  onChange={(e) => onChange({ itemsCommand: e.target.value })}
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Each non-blank line of stdout becomes one iteration's <code>{'{{item}}'}</code>.
                </p>
              </div>
              <div>
                <label className={label}>Overall timeout (ms, optional)</label>
                <input
                  className={field} type="number" value={node.timeoutMs ?? ''} placeholder="60000"
                  onChange={(e) => onChange({ timeoutMs: num(e.target.value) })}
                />
              </div>
            </div>
          )}
        </>
      )}

      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[var(--bark-700)]">
        <div>
          <label className={label}>Run only if</label>
          <select className={field} value={node.runIf ?? ''} onChange={(e) => onChange({ runIf: e.target.value || undefined })}>
            <option value="">Always runs</option>
            {earlierNodes.map((n) => (
              <option key={n.id} value={n.id}>{n.name || n.id} passed</option>
            ))}
          </select>
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-[12px] text-slate-300">
            <input type="checkbox" checked={node.optional ?? false} onChange={(e) => onChange({ optional: e.target.checked || undefined })} />
            Optional (a failing child is reported but doesn't block the recipe)
          </label>
        </div>
      </div>
    </div>
  );
}

export default GroupLoopEditor;
