import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, ChevronRight, Plus } from 'lucide-react';
import { type ModelProvider } from '../api/models';
import { listLlmProviders, credentialKeys, type LlmProviderStatus } from '../api/credentials';
import { listClusters, clusterKeys } from '../api/clusters';
import { modelOptionLabel } from '../lib/model-label';
import {
  tierModels, modelRowLabel, formatPrice, formatContext, formatIntelligence, sourceOf,
  type ModelGroup,
} from '../lib/model-groups';

interface ModelPickerProps {
  models: ModelProvider[];
  selectedId: string | null;
  onSelect: (modelId: string) => void;
  /** The account default, so what everything already falls back to sorts up. */
  defaultModelId?: string | null | undefined;
  /** Rendered above everything as the "no explicit choice" row. Omit to require a choice. */
  inheritOption?: { label: string; onSelect: () => void } | undefined;
  /** Where an unconfigured gateway sends you. Omit to list them without a click target. */
  onConfigure?: ((provider: string) => void) | undefined;
  autoFocus?: boolean;
}

const Tier = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className="px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-600 bg-[var(--bark-950,#090d0b)]">
      {label}
    </div>
    {children}
  </div>
);

/**
 * The model list: what you control, then what you have set up, then what you could.
 *
 * Registering one gateway key writes a row per model — hundreds — so a flat list buries the one box
 * you actually stood up. Collapsed, a gateway is a single line whatever its size, and inside it the
 * free models are collected ahead of the vendors.
 */
export function ModelPicker({
  models, selectedId, onSelect, defaultModelId, inheritOption, onConfigure, autoFocus = false,
}: ModelPickerProps) {
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const query = filter.trim().toLowerCase();

  const { data: gateways = [] } = useQuery<LlmProviderStatus[]>({
    queryKey: credentialKeys.llm(),
    queryFn: listLlmProviders,
  });
  const { data: clusters = [] } = useQuery({
    queryKey: clusterKeys.list(),
    queryFn: listClusters,
  });

  const { local, provisioned } = useMemo(() => {
    const matching = query
      ? models.filter((m) => modelOptionLabel(m).toLowerCase().includes(query))
      : models;
    return tierModels(matching, { defaultModelId, selectedModelId: selectedId });
  }, [models, query, defaultModelId, selectedId]);

  const unconfigured = useMemo(
    () => gateways.filter((g) => (g.modelCount ?? 0) === 0),
    [gateways],
  );

  const matchCount = [...local, ...provisioned].reduce((n, g) => n + g.models.length, 0);
  const toggle = (key: string) => setOpened((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const clusterName = (m: ModelProvider): string | undefined =>
    clusters.find((c) => c.id === m.clusterId)?.name;

  const modelRow = (m: ModelProvider, underVendor: boolean, indent: string) => {
    const price = formatPrice(m);
    const intelligence = formatIntelligence(m);
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => onSelect(m.id)}
        className={`w-full text-left ${indent} pr-3 py-1 text-[11px] font-mono flex items-center gap-1.5 transition-colors ${
          m.id === selectedId
            ? 'bg-emerald-600/20 text-emerald-200'
            : 'text-slate-300 hover:bg-[var(--bark-900,#111814)] hover:text-emerald-300'
        }`}
      >
        {m.id === selectedId && <Check size={11} className="flex-shrink-0" />}
        <span className="truncate">{modelRowLabel(m, underVendor)}</span>
        <span className="ml-auto pl-2 text-[10px] text-slate-500 shrink-0 flex gap-1.5 items-center">
          {intelligence && (
            <span
              title="Artificial Analysis Intelligence Index"
              className="px-1 rounded bg-sky-500/15 text-sky-300 font-semibold"
            >
              {intelligence}
            </span>
          )}
          {formatContext(m.contextTokens) && <span>{formatContext(m.contextTokens)}</span>}
          {price && <span className={price === 'free' ? 'text-emerald-500' : ''}>{price}</span>}
        </span>
      </button>
    );
  };

  const sourceBlock = (group: ModelGroup) => {
    const holds = group.models.some((m) => m.id === selectedId);
    const isOpen = opened.has(group.key) || !!query || holds;

    return (
      <div key={group.key}>
        <button
          type="button"
          onClick={() => toggle(group.key)}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${group.label}`}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bark-900,#111814)] transition-colors cursor-pointer"
        >
          {holds && <Check size={11} className="text-emerald-400 shrink-0" />}
          <span className="text-[11px] font-bold text-slate-200 truncate">{group.label}</span>
          <span className="ml-auto text-[10px] text-slate-500 font-mono shrink-0">{group.models.length}</span>
          <ChevronRight size={12} className={`text-slate-500 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        </button>

        {isOpen && (
          <div className="pb-1 bg-[var(--bark-900,#111814)]/40">
            {group.vendors.map((vendor) => {
              const vendorHolds = vendor.models.some((m) => m.id === selectedId);
              const vendorOpen = opened.has(vendor.key) || !!query || vendorHolds;
              return (
                <div key={vendor.key}>
                  <button
                    type="button"
                    onClick={() => toggle(vendor.key)}
                    aria-expanded={vendorOpen}
                    aria-label={`${vendorOpen ? 'Collapse' : 'Expand'} ${vendor.label}`}
                    className="w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-left hover:bg-[var(--bark-900,#111814)] transition-colors cursor-pointer"
                  >
                    {vendorHolds && <Check size={10} className="text-emerald-400 shrink-0" />}
                    <span className={`text-[11px] truncate ${vendor.free ? 'text-emerald-400 font-semibold' : 'text-slate-300'}`}>
                      {vendor.label}
                    </span>
                    <span className="ml-auto text-[10px] text-slate-600 font-mono shrink-0">{vendor.models.length}</span>
                    <ChevronRight size={11} className={`text-slate-600 shrink-0 transition-transform ${vendorOpen ? 'rotate-90' : ''}`} />
                  </button>
                  {vendorOpen && vendor.models.map((m) => modelRow(m, !vendor.free, 'pl-12'))}
                </div>
              );
            })}
            {group.ungrouped.map((m) => modelRow(m, false, 'pl-8'))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          autoFocus={autoFocus}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${models.length} models...`}
          aria-label="Filter models"
          className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md pl-7 pr-2.5 py-1.5 text-xs text-slate-100 focus:outline-none"
        />
      </div>

      <div className="border border-[var(--bark-800,#1b2620)] rounded-md bg-[var(--bark-950,#090d0b)] max-h-80 overflow-y-auto divide-y divide-[var(--bark-800,#1b2620)]">
        {inheritOption && !query && (
          <button
            type="button"
            onClick={inheritOption.onSelect}
            className={`w-full text-left px-3 py-2 text-[11px] flex items-center gap-1.5 transition-colors ${
              selectedId === null ? 'bg-emerald-600/20 text-emerald-200' : 'text-slate-300 hover:bg-[var(--bark-900,#111814)]'
            }`}
          >
            {selectedId === null && <Check size={12} className="flex-shrink-0" />}
            <span className="truncate">{inheritOption.label}</span>
          </button>
        )}

        {local.length > 0 && (
          <Tier label="Local">
            {/* One local model is not worth a group to expand — show it and what it runs on. */}
            {local.length === 1 && local[0]!.models.length === 1
              ? (() => {
                  const m = local[0]!.models[0]!;
                  const where = [sourceOf(m), clusterName(m) ?? m.name, formatContext(m.contextTokens)]
                    .filter(Boolean).join(' · ');
                  return (
                    <button
                      type="button"
                      onClick={() => onSelect(m.id)}
                      className={`w-full text-left px-3 py-2 transition-colors ${
                        m.id === selectedId
                          ? 'bg-emerald-600/20 text-emerald-200'
                          : 'text-slate-300 hover:bg-[var(--bark-900,#111814)]'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {m.id === selectedId && <Check size={11} className="flex-shrink-0" />}
                        <span className="text-[11px] font-mono truncate">{modelRowLabel(m, false)}</span>
                      </span>
                      <span className="block text-[10px] text-slate-500 mt-0.5 pl-0.5">{where}</span>
                    </button>
                  );
                })()
              : local.map(sourceBlock)}
          </Tier>
        )}

        {provisioned.length > 0 && (
          <Tier label="Provisioned">{provisioned.map(sourceBlock)}</Tier>
        )}

        {unconfigured.length > 0 && !query && (
          <Tier label="Not set up">
            {unconfigured.map((g) => (
              <button
                key={g.provider}
                type="button"
                onClick={onConfigure ? () => onConfigure(g.provider) : undefined}
                disabled={!onConfigure}
                title={onConfigure ? `Add an API key for ${g.label}` : `${g.label} is available but not configured`}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-slate-500 ${
                  onConfigure ? 'hover:bg-[var(--bark-900,#111814)] hover:text-slate-300 cursor-pointer' : ''
                }`}
              >
                <span className="truncate">{g.label}</span>
                {onConfigure && <Plus size={11} className="ml-auto shrink-0" />}
              </button>
            ))}
          </Tier>
        )}

        {models.length === 0 && unconfigured.length === 0 && (
          <p className="text-[11px] text-amber-400/80 px-3 py-4">
            No models connected — add one in Cloud Accounts.
          </p>
        )}
        {models.length > 0 && matchCount === 0 && (
          <p className="text-[11px] text-slate-500 px-3 py-4">No model matches "{filter}".</p>
        )}
      </div>

      {query && matchCount > 0 && (
        <p className="text-[10px] text-slate-600">{matchCount} of {models.length} match.</p>
      )}
    </div>
  );
}
