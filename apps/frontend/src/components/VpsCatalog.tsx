import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import axios from 'axios';
import { RefreshCw, Loader2, AlertTriangle, Check, Server, Info, ArrowUp, ArrowDown } from 'lucide-react';

/**
 * Live VPS plan search across providers.
 *
 * Prices here come from each provider's own catalogue API at request time rather than a list
 * baked into the app — Hetzner alone changed prices three times in 2026 and nearly tripled its
 * dedicated-vCPU line, which is exactly how a hardcoded table becomes bad advice.
 */

interface VpsOffer {
  id: string; provider: string; planId: string; label: string;
  vcpu: number; cpuType: string; cpuVendor?: string; arch: string;
  ramGb: number; diskGb: number; diskType?: string; bandwidthTb?: number;
  priceMonthly: number; priceHourly?: number; currency: string; taxIncluded: boolean;
  hourlyBilling: boolean; locations: string[]; provisionable: boolean; pricePerGbRam: number;
}
interface VpsSource {
  provider: string; status: 'ok' | 'no-credentials' | 'error';
  offerCount: number; message?: string; requiresCredentials: boolean; cached: boolean;
}
interface CatalogResult { offers: VpsOffer[]; sources: VpsSource[]; fetchedAt: string }

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€' };

export default function VpsCatalog({ apiBase }: { apiBase: string }) {
  const [minRamGb, setMinRamGb] = useState('');
  const [minVcpu, setMinVcpu] = useState('');
  const [minDiskGb, setMinDiskGb] = useState('');
  const [maxPriceMonthly, setMaxPriceMonthly] = useState('');
  const [location, setLocation] = useState('');
  const [arch, setArch] = useState('x86');
  const [cpuType, setCpuType] = useState('');
  const [provisionableOnly, setProvisionableOnly] = useState(false);
  const [hourlyOnly, setHourlyOnly] = useState(false);
  const [sort, setSort] = useState('pricePerGbRam');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const params = new URLSearchParams(
    Object.entries({
      minRamGb, minVcpu, minDiskGb, maxPriceMonthly, location, arch, cpuType, sort, sortDir,
      provisionableOnly: provisionableOnly ? 'true' : '',
      hourlyOnly: hourlyOnly ? 'true' : '',
      limit: '60',
    }).filter(([, v]) => v !== '') as [string, string][],
  );

  const { data, isFetching, refetch, error } = useQuery<CatalogResult>({
    queryKey: ['vps-catalog', params.toString()],
    queryFn: () => axios.get(`${apiBase}/vps-catalog?${params}`).then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const refresh = useMutation({
    mutationFn: () => axios.post(`${apiBase}/vps-catalog/refresh`),
    onSuccess: () => refetch(),
  });

  const money = (n: number, c: string) => `${CURRENCY_SYMBOL[c] ?? ''}${n.toFixed(2)}`;

  /**
   * First click on a column uses whatever direction reads naturally for it — cheapest-first for
   * prices, biggest-first for capacities — and clicking the active column flips it. Kept in sync
   * with NATURAL_SORT_DIR on the backend, which applies the same defaults when none is sent.
   */
  const NATURAL_DIR: Record<string, 'asc' | 'desc'> = {
    price: 'asc', pricePerGbRam: 'asc', name: 'asc',
    ram: 'desc', vcpu: 'desc', disk: 'desc', bandwidth: 'desc',
  };

  const toggleSort = (key: string) => {
    if (sort === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setSortDir(NATURAL_DIR[key] ?? 'asc'); }
  };

  // Sorting is applied server-side on purpose. The query is limited to 60 rows, so re-ordering
  // only what's already loaded would show the top 60 by the PREVIOUS sort, re-sorted — quietly
  // the wrong answer.
  const sortableHeader = (key: string, label: string, align: 'left' | 'right' = 'right', pad = 'px-3') => {
    const active = sort === key;
    return (
      <th className={`${align === 'left' ? 'text-left' : 'text-right'} ${pad} py-3`}>
        <button
          onClick={() => toggleSort(key)}
          className={`inline-flex items-center gap-1 uppercase tracking-widest font-black transition-colors hover:text-slate-200 ${
            active ? 'text-blue-400' : 'text-slate-500'
          } ${align === 'right' ? 'flex-row-reverse' : ''}`}
          title={active ? `Sorted ${sortDir === 'asc' ? 'ascending' : 'descending'} — click to reverse` : `Sort by ${label}`}
        >
          {label}
          {active
            ? (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)
            : <span className="w-[11px]" aria-hidden />}
        </button>
      </th>
    );
  };

  const numField = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <div>
      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">{label}</label>
      <input
        type="number" value={value} placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-700 focus:outline-none focus:border-blue-500"
      />
    </div>
  );

  return (
    <section>
      <header className="mb-8">
        <h2 className="text-3xl font-bold flex items-center gap-3">
          <Server className="text-blue-500" size={28} /> VPS Catalog
        </h2>
        <p className="text-slate-400 mt-2 text-sm">
          Live plans and prices pulled from each provider's own API. Filter for what an app actually
          needs instead of guessing at a size.
        </p>
      </header>

      <div className="bg-slate-800/50 border border-slate-700/50 rounded-3xl p-6 mb-6">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {numField('Min RAM (GB)', minRamGb, setMinRamGb, 'any')}
          {numField('Min vCPU', minVcpu, setMinVcpu, 'any')}
          {numField('Min disk (GB)', minDiskGb, setMinDiskGb, 'any')}
          {numField('Max price / mo', maxPriceMonthly, setMaxPriceMonthly, 'any')}
          <div>
            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Location</label>
            <input
              value={location} placeholder="e.g. us, fsn, ash"
              onChange={(e) => setLocation(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-700 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 mt-5 pt-5 border-t border-slate-700/50">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Arch</label>
            <select value={arch} onChange={(e) => setArch(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
              <option value="">Any</option>
              <option value="x86">x86 only</option>
              <option value="arm">ARM only</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">vCPU</label>
            <select value={cpuType} onChange={(e) => setCpuType(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
              <option value="">Any</option>
              <option value="shared">Shared</option>
              <option value="dedicated">Dedicated</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input type="checkbox" checked={provisionableOnly} onChange={(e) => setProvisionableOnly(e.target.checked)} className="w-4 h-4 accent-blue-500" />
            Deployable from here
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input type="checkbox" checked={hourlyOnly} onChange={(e) => setHourlyOnly(e.target.checked)} className="w-4 h-4 accent-blue-500" />
            Hourly billing
          </label>
          <div className="flex-1" />
          <button
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || isFetching}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold flex items-center gap-2 disabled:opacity-50"
            title="Bypass the 6-hour cache and re-query every provider"
          >
            {refresh.isPending || isFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh prices
          </button>
        </div>
      </div>

      {/* Per-provider status — explains any provider that's missing rather than silently omitting it. */}
      {data?.sources && (
        <div className="flex flex-wrap gap-2 mb-5">
          {data.sources.map((s) => (
            <div key={s.provider}
              title={s.message ?? ''}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold flex items-center gap-1.5 border ${
                s.status === 'ok' ? 'bg-green-500/5 border-green-500/20 text-green-400'
                : s.status === 'no-credentials' ? 'bg-slate-500/5 border-slate-600/30 text-slate-400'
                : 'bg-red-500/5 border-red-500/20 text-red-400'
              }`}>
              {s.status === 'ok' ? <Check size={11} /> : s.status === 'no-credentials' ? <Info size={11} /> : <AlertTriangle size={11} />}
              {s.provider}
              {s.status === 'ok' && <span className="text-slate-500">{s.offerCount} plans{s.cached ? ' · cached' : ''}</span>}
              {s.status === 'no-credentials' && <span className="text-slate-600">add a token to include</span>}
              {s.status === 'error' && <span className="text-slate-500">unavailable</span>}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs mb-4">
          Couldn't load the catalog: {(error as any).message}
        </div>
      )}

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-3xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-[10px] font-black text-slate-500 uppercase tracking-widest">
            <tr>
              {sortableHeader('name', 'Provider / Plan', 'left')}
              {sortableHeader('vcpu', 'vCPU')}
              {sortableHeader('ram', 'RAM')}
              {sortableHeader('disk', 'Disk')}
              {sortableHeader('bandwidth', 'Bandwidth')}
              {sortableHeader('pricePerGbRam', 'Per GB RAM')}
              {sortableHeader('price', 'Price / mo', 'right', 'px-5')}
            </tr>
          </thead>
          <tbody>
            {isFetching && !data && (
              <tr><td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                <Loader2 className="animate-spin inline mr-2" size={16} /> Querying providers…
              </td></tr>
            )}
            {data?.offers.length === 0 && (
              <tr><td colSpan={7} className="px-5 py-10 text-center text-slate-500 text-xs">
                No plans match these filters. Try relaxing the RAM or price limit.
              </td></tr>
            )}
            {data?.offers.map((o) => (
              <tr key={o.id} className="border-t border-slate-800/60 hover:bg-slate-800/30">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-200">{o.planId}</span>
                    {o.provisionable && (
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 uppercase tracking-wider"
                        title="This platform can provision a cluster on this provider">deployable</span>
                    )}
                    {o.arch === 'arm' && (
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 uppercase tracking-wider"
                        title="ARM — will not run x86-only images such as SteamCMD game servers">arm</span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-600 mt-0.5">
                    {o.provider} · {o.cpuType}{o.cpuVendor ? ` · ${o.cpuVendor}` : ''}
                    {o.locations.length > 0 && ` · ${o.locations.length} locations`}
                  </div>
                </td>
                <td className="text-right px-3 py-3 text-slate-300">{o.vcpu}</td>
                <td className="text-right px-3 py-3 text-slate-300">{o.ramGb} GB</td>
                <td className="text-right px-3 py-3 text-slate-400">{o.diskGb > 0 ? `${o.diskGb} GB` : '—'}</td>
                <td className="text-right px-3 py-3 text-slate-400">{o.bandwidthTb ? `${o.bandwidthTb.toFixed(1)} TB` : '—'}</td>
                <td className="text-right px-3 py-3 text-slate-400">{money(o.pricePerGbRam, o.currency)}</td>
                <td className="text-right px-5 py-3">
                  <div className="font-bold text-white">{money(o.priceMonthly, o.currency)}</div>
                  <div className="text-[10px] text-slate-600">
                    {o.currency}{!o.taxIncluded && ' · ex. tax'}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-5 bg-blue-500/5 border border-blue-500/20 rounded-2xl p-4 flex items-start gap-3">
        <Info className="text-blue-500 flex-shrink-0 mt-0.5" size={16} />
        <div className="text-[11px] text-slate-400 leading-relaxed space-y-1">
          <p>
            <strong className="text-slate-300">Prices are not converted between currencies.</strong> A
            EUR and a USD row are not directly comparable — a hardcoded exchange rate would go stale
            the same way a hardcoded price list does. All figures are excluding tax.
          </p>
          <p>
            <strong className="text-slate-300">"Deployable"</strong> marks providers this platform can
            actually provision a cluster on. The rest are listed for price comparison only.
          </p>
          {data?.fetchedAt && (
            <p className="text-slate-600">
              Fetched {new Date(data.fetchedAt).toLocaleString()} · cached up to 6 hours
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
