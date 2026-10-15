import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { getReleaseOptions, releaseSettingKeys } from '../../api/release-settings.js';
import { field, label, type TreeType } from './shared.js';

export function Release({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const { data: options } = useQuery({ queryKey: releaseSettingKeys.options(), queryFn: getReleaseOptions });
  const agents = options?.agents ?? [];
  const apps = options?.apps ?? [];
  const chosen = value.release?.agent;
  const agent = agents.find((entry) => entry.slug === chosen);

  const pickAgent = (slug: string) => {
    if (!slug) return onChange({ release: undefined });
    const next = agents.find((entry) => entry.slug === slug);
    onChange({ release: { agent: slug, ...(next?.needsApp ? { app: value.release?.app ?? apps[0]?.id ?? '' } : {}) } });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className={label} htmlFor="release-agent">Released by</label>
        <div className="flex flex-wrap items-center gap-2">
          <select id="release-agent" aria-label="Agent that releases builds" className={`${field} sm:max-w-sm`} value={chosen ?? ''} onChange={(event) => pickAgent(event.target.value)}>
            <option value="">what the repository holds — beside the live app with a chart, otherwise replacing it</option>
            {agents.map((entry) => (
              <option key={entry.slug} value={entry.slug}>{entry.name} ({entry.slug})</option>
            ))}
          </select>
          {chosen && (
            <a href={`#/studio/agents/${chosen}`} className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300">
              open {chosen} <ExternalLink size={11} />
            </a>
          )}
        </div>
        {agent?.description && <p className="text-[11px] text-slate-500 mt-1">{agent.description}</p>}
      </div>
      {agent?.needsApp && (
        <div>
          <label className={label} htmlFor="release-app">App</label>
          <select id="release-app" aria-label="App adapter" className={`${field} sm:max-w-xs`} value={value.release?.app ?? ''} onChange={(event) => onChange({ release: { agent: agent.slug, app: event.target.value } })}>
            {apps.map((app) => <option key={app.id} value={app.id}>{app.title}</option>)}
          </select>
          <p className="text-[11px] text-slate-500 mt-1">What this app does when a release copies, upgrades and quiets its data.</p>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        A project of this type can be set to release another way on its own page. Copy the agent's procedure in the Studio
        to change how a release goes.
      </p>
    </div>
  );
}

export default Release;
