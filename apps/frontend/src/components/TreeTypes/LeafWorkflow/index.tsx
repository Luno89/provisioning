import { useState } from 'react';
import { DEFAULT_LEAF_WORKFLOW, type LeafWorkflowSpec, type WorkflowStageNode } from '../shared.js';
import { NodeList } from './NodeList.js';

type Which = 'onSuccess' | 'onFailure';

export function LeafWorkflowPanel({ leafWorkflow, onChange }: {
  leafWorkflow: LeafWorkflowSpec | undefined;
  onChange: (next: LeafWorkflowSpec) => void;
}) {
  const [which, setWhich] = useState<Which>('onSuccess');
  const value = leafWorkflow ?? DEFAULT_LEAF_WORKFLOW;
  const patch = (list: WorkflowStageNode[]) => onChange({ ...value, [which]: list });

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-slate-500 leading-relaxed">
        What happens after a leaf's own work finishes — release, judge, land, accept, replan — as an
        ordered, editable sequence with the same drag-and-drop, "run only if," and loop primitives as
        the validation recipe above. This starts from what already happens for every tree type; edit
        it here to change that for this type only.
      </p>

      <div className="flex gap-1">
        <Tab active={which === 'onSuccess'} onClick={() => setWhich('onSuccess')} label="On success" />
        <Tab active={which === 'onFailure'} onClick={() => setWhich('onFailure')} label="On failure" />
      </div>

      <NodeList scope={which} nodes={value[which]} onChange={patch} />
    </div>
  );
}

function Tab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[12px] px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
        active ? 'bg-[var(--leaf-stem)] text-white' : 'text-slate-400 hover:bg-[var(--bark-700)]'
      }`}
    >
      {label}
    </button>
  );
}

export default LeafWorkflowPanel;
