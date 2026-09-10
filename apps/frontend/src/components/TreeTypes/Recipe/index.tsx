import { field, label, type ValidationRecipe, type CustomStepDefinition } from '../shared.js';
import { NodeList } from './NodeList.js';

const RECIPE_TYPES: ValidationRecipe['type'][] = ['document', 'command', 'runtime-service'];

const emptyRecipe = (): ValidationRecipe => ({ type: 'command', checks: [] });

export function RecipePanel({ recipe, customSteps, onChange }: {
  recipe: ValidationRecipe | undefined;
  customSteps: readonly CustomStepDefinition[];
  onChange: (next: ValidationRecipe | undefined) => void;
}) {
  const value = recipe ?? emptyRecipe();
  const patch = (p: Partial<ValidationRecipe>) => onChange({ ...value, ...p });

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-slate-500 leading-relaxed">
        What proves a leaf of this type is actually done. Steps run in order, top to bottom — drag the
        grip handle to reorder, or drop a step onto a group/loop to move it inside. Use "Run only if" to
        make a step conditional on an earlier one, "Optional" for a step that's worth reporting but
        shouldn't block the recipe, Retries for a step that's known to be flaky, a Group to organize
        related steps, and a Loop to repeat a set of steps N times, until they pass, or once per item
        from a command.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Recipe kind</label>
          <select className={field} value={value.type} onChange={(e) => patch({ type: e.target.value as ValidationRecipe['type'] })}>
            {RECIPE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Overall timeout (ms, optional)</label>
          <input
            className={field}
            type="number"
            value={value.timeoutMs ?? ''}
            placeholder="No overall limit"
            onChange={(e) => patch({ timeoutMs: e.target.value.trim() === '' ? undefined : Number(e.target.value) })}
          />
        </div>
      </div>

      <NodeList nodes={value.checks} customSteps={customSteps} onChange={(checks) => onChange({ ...value, checks })} />
    </div>
  );
}

export default RecipePanel;
