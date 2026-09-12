import {
  field, label, WORKFLOW_STAGE_TYPES,
  type WorkflowStageDefinition, type WorkflowStageType, type WorkflowStageNode,
} from '../shared.js';
import { STAGE_LABELS, STAGE_HINTS } from './stageTemplates.js';
import { RunIfEditor } from './ConditionEditor.js';

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export function StageEditor({ stage, earlierNodes, onChange }: {
  stage: WorkflowStageDefinition;
  earlierNodes: readonly WorkflowStageNode[];
  onChange: (patch: Partial<WorkflowStageDefinition>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Name</label>
          <input className={field} value={stage.name} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div>
          <label className={label}>Stage</label>
          <select className={field} value={stage.stage} onChange={(e) => onChange({ stage: e.target.value as WorkflowStageType })}>
            {WORKFLOW_STAGE_TYPES.map((t) => <option key={t} value={t}>{STAGE_LABELS[t]}</option>)}
          </select>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 -mt-1">{STAGE_HINTS[stage.stage]}</p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Retries</label>
          <input
            className={field} type="number" min={0} value={stage.retries ?? 0}
            onChange={(e) => onChange({ retries: num(e.target.value) || undefined })}
          />
        </div>
        {!!stage.retries && (
          <div>
            <label className={label}>Delay between retries (ms)</label>
            <input
              className={field} type="number" min={0} value={stage.retryDelayMs ?? ''}
              onChange={(e) => onChange({ retryDelayMs: num(e.target.value) })}
            />
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-[var(--bark-700)] space-y-2">
        <div className="flex items-center justify-between">
          <label className={label}>Run only if</label>
          <label className="flex items-center gap-2 text-[12px] text-slate-300">
            <input type="checkbox" checked={stage.optional ?? false} onChange={(e) => onChange({ optional: e.target.checked || undefined })} />
            Optional (a thrown error is reported but doesn't block the sequence)
          </label>
        </div>
        <RunIfEditor runIf={stage.runIf} earlierNodes={earlierNodes} onChange={(runIf) => onChange({ runIf })} />
      </div>
    </div>
  );
}

export default StageEditor;
