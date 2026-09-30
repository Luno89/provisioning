import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { agentKeys, listAgents } from '../../api/agents.js';
import { field, label, type TreeStages, type TreeType } from './shared.js';

/**
 * ── DUPLICATED, KNOWINGLY ──
 * The defaults are `DEFAULT_STAGES` in `apps/backend/src/lib/grove-stages.ts`, which is the authority:
 * a stage a type leaves unnamed is resolved there when the tree runs. This is only what the picker
 * says an unnamed stage will turn out to be.
 */
const STAGES: { stage: keyof TreeStages; says: string; defaultsTo: string }[] = [
  { stage: 'plan', says: 'A goal into branches, leaves and tasks — and a leaf\'s breakdown or replan.', defaultsTo: 'planner' },
  { stage: 'work', says: 'One leaf done: each task handed on until the leaf can be claimed.', defaultsTo: 'leaf-worker' },
  { stage: 'judge', says: 'One claim weighed against what the leaf had to reach.', defaultsTo: 'grove-runner' },
];

export function Stages({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const { data: agents = [] } = useQuery({ queryKey: agentKeys.all, queryFn: listAgents });
  const bySlug = new Map(agents.map((agent) => [agent.slug, agent]));

  // A stage nobody is named for is left out rather than named "", which the save would refuse.
  const choose = (stage: keyof TreeStages, slug: string) => {
    const stages: TreeStages = { ...(value.stages ?? {}) };
    if (slug) stages[stage] = slug;
    else delete stages[stage];
    onChange({ stages: Object.keys(stages).length > 0 ? stages : undefined });
  };

  return (
    <div className="space-y-4">
      {STAGES.map(({ stage, says, defaultsTo }) => {
        const chosen = value.stages?.[stage];
        const resolved = chosen ?? defaultsTo;
        const procedure = bySlug.get(resolved)?.procedure;

        return (
          <div key={stage}>
            <label className={label} htmlFor={`stage-${stage}`}>
              {stage} {chosen ? `— ${chosen}` : `— default, ${defaultsTo}`}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id={`stage-${stage}`}
                aria-label={`Agent for the ${stage} stage`}
                className={`${field} sm:max-w-sm`}
                value={chosen ?? ''}
                onChange={(event) => choose(stage, event.target.value)}
              >
                <option value="">default — {defaultsTo}</option>
                {agents.map((agent) => (
                  <option key={agent.slug} value={agent.slug}>
                    {agent.slug}{agent.mine ? '' : ' (built-in)'}
                  </option>
                ))}
              </select>
              {procedure && (
                <a
                  href={`#/studio/${procedure}`}
                  className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300"
                >
                  open {procedure} <ExternalLink size={11} />
                </a>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{says}</p>
          </div>
        );
      })}
    </div>
  );
}

export default Stages;
