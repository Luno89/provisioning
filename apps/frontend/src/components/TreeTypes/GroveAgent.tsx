import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { agentKeys, listAgents } from '../../api/agents.js';
import { field, label, type TreeType } from './shared.js';

/**
 * ── DUPLICATED, KNOWINGLY ──
 * `DEFAULT_GROVE_AGENT` in `apps/backend/src/lib/tree-types.ts` is the authority: a type that names no
 * agent is grown by it. This is only what the picker says an unnamed agent will turn out to be.
 */
const DEFAULT_GROVE_AGENT = 'grove';

export function GroveAgent({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const { data: agents = [] } = useQuery({ queryKey: agentKeys.all, queryFn: listAgents });
  const chosen = value.agent;
  const resolved = chosen ?? DEFAULT_GROVE_AGENT;
  const procedure = agents.find((agent) => agent.slug === resolved)?.procedure;

  return (
    <div>
      <label className={label} htmlFor="grove-agent">
        {chosen ?? `${DEFAULT_GROVE_AGENT}, the default`}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="grove-agent"
          aria-label="Agent that grows trees of this type"
          className={`${field} sm:max-w-sm`}
          value={chosen ?? ''}
          onChange={(event) => onChange({ agent: event.target.value || undefined })}
        >
          <option value="">default — {DEFAULT_GROVE_AGENT}</option>
          {agents.map((agent) => (
            <option key={agent.slug} value={agent.slug}>
              {agent.slug}{agent.mine ? '' : ' (built-in)'}
            </option>
          ))}
        </select>
        {procedure && (
          <a href={`#/studio/${procedure}`} className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300">
            open {procedure} <ExternalLink size={11} />
          </a>
        )}
      </div>
      <p className="text-[11px] text-slate-500 mt-1">
        Its procedure is how a tree of this type grows: which agents work, judge and plan its leaves, and every limit
        on them. Copy it in the Studio to change any of that.
      </p>
    </div>
  );
}

export default GroveAgent;
