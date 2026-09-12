import { Plus, Trash2 } from 'lucide-react';
import { field, label, type WorkflowCondition, type WorkflowStageNode } from '../shared.js';

type ValueType = 'string' | 'number' | 'boolean';

const REF_OPS = ['ranOk', 'threw'] as const;
const COMPARE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;
const PATH_OPS = ['exists', 'notExists'] as const;
const COMBINE_OPS = ['and', 'or'] as const;

const OP_LABELS: Record<WorkflowCondition['op'], string> = {
  ranOk: 'stage ran ok',
  threw: 'stage threw',
  eq: 'equals',
  neq: 'does not equal',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  exists: 'is set',
  notExists: 'is not set',
  and: 'all of',
  or: 'any of',
  not: 'not',
};

function valueTypeOf(v: string | number | boolean): ValueType {
  return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
}

function defaultForOp(op: WorkflowCondition['op'], earlierIds: string[]): WorkflowCondition {
  switch (op) {
    case 'ranOk':
    case 'threw':
      return { op, ref: earlierIds[0] ?? '' };
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
      return { op, path: '', value: '' };
    case 'exists': case 'notExists':
      return { op, path: '' };
    case 'and': case 'or':
      return { op, conditions: [] };
    case 'not':
      return { op, condition: { op: 'ranOk', ref: earlierIds[0] ?? '' } };
  }
}

export function ConditionEditor({ condition, earlierNodes, onChange }: {
  condition: WorkflowCondition;
  earlierNodes: readonly { id: string; name: string }[];
  onChange: (next: WorkflowCondition) => void;
}) {
  const earlierIds = earlierNodes.map((n) => n.id);
  const changeOp = (op: WorkflowCondition['op']) => onChange(defaultForOp(op, earlierIds));

  return (
    <div className="space-y-2">
      <select className={`${field} w-auto`} value={condition.op} onChange={(e) => changeOp(e.target.value as WorkflowCondition['op'])}>
        <optgroup label="Stage outcome">
          {REF_OPS.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
        </optgroup>
        <optgroup label="Compare a value">
          {COMPARE_OPS.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
        </optgroup>
        <optgroup label="Path">
          {PATH_OPS.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
        </optgroup>
        <optgroup label="Combine">
          {COMBINE_OPS.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
          <option value="not">{OP_LABELS.not}</option>
        </optgroup>
      </select>

      {(condition.op === 'ranOk' || condition.op === 'threw') && (
        <select className={field} value={condition.ref} onChange={(e) => onChange({ ...condition, ref: e.target.value })}>
          <option value="">Pick a stage…</option>
          {earlierNodes.map((n) => <option key={n.id} value={n.id}>{n.name || n.id}</option>)}
        </select>
      )}

      {(condition.op === 'eq' || condition.op === 'neq' || condition.op === 'gt' || condition.op === 'gte' || condition.op === 'lt' || condition.op === 'lte') && (
        <div className="grid grid-cols-[1fr_90px_1fr] gap-2 items-start">
          <div>
            <label className={label}>Path</label>
            <input
              className={field} value={condition.path} placeholder="stages.land.output.stuck.length"
              onChange={(e) => onChange({ ...condition, path: e.target.value })}
            />
          </div>
          <div>
            <label className={label}>Type</label>
            <select
              className={field}
              value={valueTypeOf(condition.value)}
              onChange={(e) => {
                const t = e.target.value as ValueType;
                const value = t === 'number' ? Number(condition.value) || 0 : t === 'boolean' ? Boolean(condition.value) : String(condition.value);
                onChange({ ...condition, value });
              }}
            >
              <option value="string">text</option>
              <option value="number">number</option>
              <option value="boolean">true/false</option>
            </select>
          </div>
          <div>
            <label className={label}>Value</label>
            {valueTypeOf(condition.value) === 'boolean' ? (
              <select
                className={field} value={String(condition.value)}
                onChange={(e) => onChange({ ...condition, value: e.target.value === 'true' })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                className={field}
                type={valueTypeOf(condition.value) === 'number' ? 'number' : 'text'}
                value={condition.value as string | number}
                onChange={(e) => onChange({ ...condition, value: valueTypeOf(condition.value) === 'number' ? Number(e.target.value) : e.target.value })}
              />
            )}
          </div>
        </div>
      )}

      {(condition.op === 'exists' || condition.op === 'notExists') && (
        <div>
          <label className={label}>Path</label>
          <input
            className={field} value={condition.path} placeholder="stages.land.output.stuck"
            onChange={(e) => onChange({ ...condition, path: e.target.value })}
          />
        </div>
      )}

      {(condition.op === 'and' || condition.op === 'or') && (
        <div className="space-y-2 pl-3 border-l-2 border-[var(--bark-700)]">
          {condition.conditions.map((c, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <ConditionEditor
                  condition={c} earlierNodes={earlierNodes}
                  onChange={(next) => {
                    const conditions = [...condition.conditions];
                    conditions[i] = next;
                    onChange({ ...condition, conditions });
                  }}
                />
              </div>
              <button
                type="button"
                title="Remove condition"
                onClick={() => onChange({ ...condition, conditions: condition.conditions.filter((_, j) => j !== i) })}
                className="p-1 mt-1 text-slate-500 hover:text-red-400 cursor-pointer"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange({ ...condition, conditions: [...condition.conditions, defaultForOp('ranOk', earlierIds)] })}
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <Plus size={12} /> Add condition
          </button>
        </div>
      )}

      {condition.op === 'not' && (
        <div className="pl-3 border-l-2 border-[var(--bark-700)]">
          <ConditionEditor
            condition={condition.condition} earlierNodes={earlierNodes}
            onChange={(next) => onChange({ ...condition, condition: next })}
          />
        </div>
      )}
    </div>
  );
}

type RunIf = WorkflowCondition | string | undefined;

export function RunIfEditor({ runIf, earlierNodes, onChange }: {
  runIf: RunIf;
  earlierNodes: readonly WorkflowStageNode[];
  onChange: (next: RunIf) => void;
}) {
  const mode = runIf === undefined ? 'always' : typeof runIf === 'string' ? 'simple' : 'custom';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          className={`${field} w-auto`}
          value={mode}
          onChange={(e) => {
            const next = e.target.value;
            if (next === 'always') onChange(undefined);
            else if (next === 'simple') onChange(earlierNodes[0]?.id ?? '');
            else onChange({ op: 'ranOk', ref: earlierNodes[0]?.id ?? '' });
          }}
        >
          <option value="always">Always runs</option>
          <option value="simple">Runs if a stage ran ok</option>
          <option value="custom">Custom condition</option>
        </select>

        {mode === 'simple' && (
          <select className={field} value={runIf as string} onChange={(e) => onChange(e.target.value)}>
            <option value="">Pick a stage…</option>
            {earlierNodes.map((n) => <option key={n.id} value={n.id}>{n.name || n.id}</option>)}
          </select>
        )}
      </div>

      {mode === 'custom' && (
        <ConditionEditor condition={runIf as WorkflowCondition} earlierNodes={earlierNodes} onChange={onChange} />
      )}
    </div>
  );
}

export default ConditionEditor;
