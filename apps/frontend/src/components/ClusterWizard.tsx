import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, AlertTriangle, Loader2, ExternalLink, KeyRound } from 'lucide-react';
import { listMeshDevices } from '../api/mesh';
import { listClusterProviders, type ClusterProviderSpec } from '../api/cluster-providers';
import { useQuery } from '@tanstack/react-query';
import { getVpsCatalog } from '../api/vps-catalog';
import { validateCredentials, saveCredentials } from '../api/credentials';

const catalogQueryFor = (providerValue: string) =>
  `provider=${providerValue}&provisionableOnly=true&arch=x86&minRamGb=8&sort=price&sortDir=asc&limit=100`;

const LOCATION_LABELS: Record<string, string> = {
  nbg1: 'Nuremberg, Germany',
  fsn1: 'Falkenstein, Germany',
  hel1: 'Helsinki, Finland',
  ash: 'Ashburn, VA, USA',
  hil: 'Hillsboro, OR, USA',
  sin: 'Singapore',
};

const FALLBACK_PLANS = [
  { planId: 'cx33', vcpu: 4, ramGb: 8 },
  { planId: 'cx43', vcpu: 8, ramGb: 16 },
  { planId: 'cx53', vcpu: 16, ramGb: 32 },
  { planId: 'ccx23', vcpu: 4, ramGb: 16 },
  { planId: 'ccx33', vcpu: 8, ramGb: 32 },
];
const FALLBACK_LOCATIONS = ['nbg1', 'fsn1', 'hel1', 'ash', 'hil', 'sin'];

interface MeshDevice {
  id: string;
  name: string;
  ipAddresses: string[];
  online: boolean;
}

interface CatalogOffer {
  planId: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  cpuType: string;
  priceMonthly: number;
  priceHourly?: number;
  bandwidthTb?: number;
  currency: string;
  locations: string[];
}

interface Props {
  configuredProviders: { provider: string; configured: boolean }[];
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  submitting?: boolean;
  onCredentialsSaved?: () => void;
  preset?: { provider: string; serverType?: string; location?: string };
}

export default function ClusterWizard({
  configuredProviders,
  onCancel,
  onSubmit,
  submitting,
  onCredentialsSaved,
  preset,
}: Props) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState(preset?.provider ?? 'k3d');

  const [token, setToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tokenResult, setTokenResult] = useState<{ valid?: boolean; message?: string } | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);

  const [serverType, setServerType] = useState(preset?.serverType ?? 'cx53');
  const [location, setLocation] = useState(preset?.location ?? 'nbg1');

  const [offers, setOffers] = useState<CatalogOffer[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);

  const [meshDevices, setMeshDevices] = useState<MeshDevice[] | null>(null);
  const [remoteHost, setRemoteHost] = useState('');
  const [remoteUsername, setRemoteUsername] = useState('root');

  const { data: providers = [] } = useQuery({
    queryKey: ['cluster-providers', 'list'],
    queryFn: listClusterProviders,
    staleTime: Infinity,
  });

  const selected: ClusterProviderSpec | undefined = providers.find((p) => p.value === provider);
  const hasCatalog = !!selected?.hasCatalog;
  const usesMesh = !!selected?.usesMesh;
  const catalogProviderValue = selected?.value ?? '';
  const credentialKey = selected?.credentialKey;
  const alreadyConfigured = !!credentialKey && configuredProviders.some((p) => p.provider === credentialKey && p.configured);

  const needsCredentialStep = !!credentialKey && !alreadyConfigured && !tokenSaved;
  const needsOptionsStep = hasCatalog;
  const needsRemoteStep = usesMesh;

  useEffect(() => {
    if (!usesMesh) return;
    let cancelled = false;
    listMeshDevices()
      .then((d) => { if (!cancelled) setMeshDevices(Array.isArray(d) ? d : []); })
      .catch(() => { if (!cancelled) setMeshDevices([]); });
    return () => { cancelled = true; };
  }, [usesMesh]);

  const hasToken = alreadyConfigured || tokenSaved;
  useEffect(() => {
    if (!hasCatalog || !hasToken) return;
    let cancelled = false;
    getVpsCatalog(catalogQueryFor(catalogProviderValue))
      .then((d) => { if (!cancelled) { setOffers(d.offers ?? []); setCatalogFailed((d.offers ?? []).length === 0); } })
      .catch(() => { if (!cancelled) setCatalogFailed(true); });
    return () => { cancelled = true; };
  }, [hasCatalog, catalogProviderValue, hasToken]);

  const plans = useMemo(() => {
    const byPlan = new Map<string, CatalogOffer>();
    for (const o of offers ?? []) {
      const seen = byPlan.get(o.planId);
      if (!seen || o.priceMonthly < seen.priceMonthly) byPlan.set(o.planId, o);
    }
    return [...byPlan.values()].sort((a, b) => a.priceMonthly - b.priceMonthly);
  }, [offers]);

  const locationChoices = useMemo(() => {
    const out: { code: string; priceMonthly: number; bandwidthTb?: number; currency: string }[] = [];
    for (const o of offers ?? []) {
      if (o.planId !== serverType) continue;
      for (const code of o.locations) {
        out.push({ code, priceMonthly: o.priceMonthly, currency: o.currency, ...(o.bandwidthTb !== undefined ? { bandwidthTb: o.bandwidthTb } : {}) });
      }
    }
    return out.sort((a, b) => a.priceMonthly - b.priceMonthly || a.code.localeCompare(b.code));
  }, [offers, serverType]);

  useEffect(() => {
    if (locationChoices.length && !locationChoices.some((l) => l.code === location)) {
      setLocation(locationChoices[0]!.code);
    }
  }, [locationChoices, location]);

  const money = (n: number, c: string) => `${c === 'EUR' ? '€' : c === 'USD' ? '$' : ''}${n.toFixed(2)}`;
  const selectedOffer = locationChoices.find((l) => l.code === location);

  const steps = [1, ...(needsCredentialStep ? [2] : []), ...(needsOptionsStep ? [3] : []), ...(needsRemoteStep ? [4] : [])];
  const isLastStep = step === steps[steps.length - 1];

  const goNext = () => {
    const idx = steps.indexOf(step);
    if (idx < steps.length - 1) setStep(steps[idx + 1]!);
  };
  const goBack = () => {
    const idx = steps.indexOf(step);
    if (idx > 0) setStep(steps[idx - 1]!);
  };

  const handleTest = async () => {
    setValidating(true);
    setTokenResult(null);
    try {
      const data = await validateCredentials(credentialKey!, { token });
      setTokenResult({ valid: !!data.valid, ...(data.message !== undefined ? { message: data.message } : {}) });
    } catch (err: any) {
      setTokenResult({ valid: false, message: `Validation failed: ${err.message}` });
    } finally {
      setValidating(false);
    }
  };

  const handleSaveToken = async () => {
    setSaving(true);
    try {
      await saveCredentials(credentialKey!, { token });
      setTokenSaved(true);
      setToken('');
      onCredentialsSaved?.();
      setStep(needsOptionsStep ? 3 : 1);
    } catch (err: any) {
      setTokenResult({ valid: false, message: `Could not save token: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = () => {
    onSubmit({
      name,
      provider,
      ...(hasCatalog ? { hetznerServerType: serverType, hetznerLocation: location } : {}),
      ...(usesMesh ? {
        remoteHost,
        remoteUsername: remoteUsername.trim() || 'root',
      } : {}),
    });
  };

  const nameCheck = useMemo((): { error?: string; suggestion?: string } => {
    const trimmed = name.trim();
    if (trimmed === '') return {};
    const suggestion = trimmed
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    const withSuggestion = (error: string) =>
      suggestion && suggestion !== trimmed ? { error, suggestion } : { error };

    if (trimmed.length > 40) return withSuggestion(`Cluster names must be 40 characters or fewer (this one is ${trimmed.length}).`);
    if (trimmed === 'provisioning-lunorica') return { error: 'That name is reserved for the management cluster.' };
    if (/\s/.test(trimmed)) return withSuggestion('Cluster names cannot contain spaces.');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed)) {
      return withSuggestion('Use only lowercase letters, numbers and hyphens, starting and ending with a letter or number.');
    }
    return {};
  }, [name]);

  const canAdvance =
    step === 1 ? name.trim().length > 0 && !nameCheck.error
    : step === 4 ? remoteHost.trim().length > 0
    : true;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-2xl font-bold">Provision New Cluster</h3>
          <div className="flex gap-2">
            {steps.map((s) => (
              <div
                key={s}
                className={`w-8 h-1.5 rounded-full transition-all ${steps.indexOf(step) >= steps.indexOf(s) ? 'bg-blue-500' : 'bg-slate-700'}`}
              />
            ))}
          </div>
        </div>

        {step === 1 && (
          <div className="space-y-6">
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                Cluster Identity
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className={`w-full bg-slate-900 border rounded-xl px-5 py-3 transition-all text-sm ${
                  nameCheck.error ? 'border-amber-500/70 focus:border-amber-500' : 'border-slate-700 focus:border-blue-500'
                }`}
                placeholder="e.g. production-omega"
              />
              {nameCheck.error && (
                <div className="mt-2 px-1 text-[11px] text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    {nameCheck.error}
                    {nameCheck.suggestion && (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => setName(nameCheck.suggestion!)}
                          className="underline underline-offset-2 hover:text-amber-300 font-semibold"
                        >
                          Use "{nameCheck.suggestion}"
                        </button>
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                Provider
              </label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm"
              >
                {providers.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              {selected?.hint && <p className="text-[11px] text-slate-500 mt-2 px-1">{selected.hint}</p>}
              {credentialKey && alreadyConfigured && (
                <p className="text-[11px] text-green-400 mt-2 px-1 flex items-center gap-1">
                  <Check size={12} /> Credentials already configured
                </p>
              )}
            </div>
            <p className="text-[11px] text-slate-500 px-1">
              GPU/LLM workloads (vLLM) run on the built-in System cluster — no separate GPU-enabled
              cluster to provision here.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 flex items-center justify-center rounded-xl bg-blue-500/10 text-blue-400">
                <KeyRound size={20} />
              </span>
              <div>
                <h4 className="font-bold text-white">{selected?.label} API Token</h4>
                <p className="text-[11px] text-slate-500">
                  Stored encrypted (AES-256-GCM) and reused for every cluster on this provider.
                </p>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  Token
                </label>
                <a
                  href="https://console.hetzner.cloud/projects"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                >
                  Get a token <ExternalLink size={10} />
                </a>
              </div>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm font-mono"
                placeholder="Read & Write token from your project's Security page"
              />
              <p className="text-[11px] text-slate-500 mt-2 px-1">
                Needs <strong>Read &amp; Write</strong> permission — this platform creates and
                destroys servers, SSH keys, and firewalls in the token's project.
              </p>
            </div>

            {tokenResult && (
              <div
                className={`p-3 rounded-xl text-xs font-semibold flex items-center gap-2 ${
                  tokenResult.valid
                    ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                    : 'bg-red-500/10 border border-red-500/20 text-red-400'
                }`}
              >
                {tokenResult.valid ? <Check size={14} /> : <AlertTriangle size={14} />}
                <span>{tokenResult.message}</span>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                Server Type
              </label>
              <select
                value={serverType}
                onChange={(e) => setServerType(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm"
              >
                {plans.length > 0
                  ? plans.map((p) => (
                      <option key={p.planId} value={p.planId}>
                        {p.planId.toUpperCase()} — {p.vcpu} {p.cpuType === 'dedicated' ? 'dedicated ' : ''}vCPU / {p.ramGb} GB
                        {' · from '}{money(p.priceMonthly, p.currency)}/mo
                      </option>
                    ))
                  : FALLBACK_PLANS.map((p) => (
                      <option key={p.planId} value={p.planId}>
                        {p.planId.toUpperCase()} — {p.vcpu} vCPU / {p.ramGb} GB
                      </option>
                    ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-2 px-1">
                k3s plus the cluster stack (Prometheus, Grafana, Traefik, Loki) uses ~5 GB before
                any app is deployed, so size for that plus whatever you plan to run. Plans under
                8 GB and ARM plans are not listed — neither can run this platform's workloads.
              </p>
              {catalogFailed && (
                <p className="text-[11px] text-amber-400/80 mt-1.5 px-1">
                  Live prices unavailable — showing a built-in plan list without pricing.
                </p>
              )}
            </div>
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                Location
              </label>
              <select
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm"
              >
                {locationChoices.length > 0
                  ? locationChoices.map((l) => (
                      <option key={l.code} value={l.code}>
                        {LOCATION_LABELS[l.code] ?? l.code} ({l.code}) — {money(l.priceMonthly, l.currency)}/mo
                        {l.bandwidthTb !== undefined ? ` · ${l.bandwidthTb} TB traffic` : ''}
                      </option>
                    ))
                  : FALLBACK_LOCATIONS.map((code) => (
                      <option key={code} value={code}>
                        {LOCATION_LABELS[code] ?? code} ({code})
                      </option>
                    ))}
              </select>
              {selectedOffer && locationChoices[0] && selectedOffer.priceMonthly > locationChoices[0].priceMonthly && (
                <p className="text-[11px] text-amber-400/90 mt-2 px-1">
                  {(selectedOffer.priceMonthly / locationChoices[0].priceMonthly).toFixed(1)}× the price of{' '}
                  {LOCATION_LABELS[locationChoices[0].code] ?? locationChoices[0].code} (
                  {money(locationChoices[0].priceMonthly, locationChoices[0].currency)}/mo) for the same plan.
                </p>
              )}
            </div>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
              <AlertTriangle className="text-amber-500 flex-shrink-0 mt-0.5" size={16} />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                This creates a real, billable server in your Hetzner project
                {selectedOffer && <> at <strong className="text-slate-300">{money(selectedOffer.priceMonthly, selectedOffer.currency)}/month</strong>, billed hourly</>}.
                Destroying the cluster from this UI deletes the server and verifies it against
                Hetzner's API.
              </p>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-6">
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                Machine
              </label>
              {meshDevices === null ? (
                <div className="text-sm text-slate-500 py-3">Loading your machines…</div>
              ) : meshDevices.length === 0 ? (
                <div className="bg-slate-900 border border-dashed border-slate-700 rounded-xl px-5 py-6 text-center text-slate-500 text-xs">
                  No machines have joined the mesh yet. Add one under <strong className="text-slate-400">My Machines</strong> first.
                </div>
              ) : (
                <select
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm"
                >
                  <option value="">Select a machine…</option>
                  {meshDevices.map((d) => (
                    <option key={d.id} value={d.ipAddresses?.[0] ?? ''} disabled={!d.ipAddresses?.[0]}>
                      {d.name} {d.ipAddresses?.[0] ? `(${d.ipAddresses[0]})` : '— no address'}{d.online ? '' : ' · offline'}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-[11px] text-slate-500 mt-2 px-1">
                The platform reaches your machine at its mesh address, so nothing needs opening on
                your router. It must be online to provision.
              </p>
            </div>

            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                SSH Username
              </label>
              <input
                value={remoteUsername}
                onChange={(e) => setRemoteUsername(e.target.value)}
                placeholder="root"
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm"
              />
              <p className="text-[11px] text-slate-500 mt-2 px-1">
                Needs root, or passwordless sudo — installing k3s writes a systemd unit and a
                binary into /usr/local/bin.
              </p>
            </div>

            <div className="bg-slate-900/50 border border-slate-700/50 rounded-2xl p-4 flex items-start gap-3">
              <KeyRound className="text-blue-400 flex-shrink-0 mt-0.5" size={16} />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Next you'll get a <strong className="text-slate-300">public key</strong> to add to
                that machine. Nothing private is ever asked for or sent from your browser — the
                platform keeps its half encrypted and uses it only to install k3s and, later, to
                remove it.
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-4 mt-10">
          <button
            type="button"
            onClick={steps.indexOf(step) > 0 ? goBack : onCancel}
            className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 transition-all text-sm font-bold flex items-center gap-2"
          >
            {steps.indexOf(step) > 0 ? (
              <>
                <ArrowLeft size={16} /> Back
              </>
            ) : (
              'Cancel'
            )}
          </button>
          <div className="flex-1" />

          {step === 2 ? (
            <>
              <button
                type="button"
                onClick={handleTest}
                disabled={validating || !token}
                className="px-5 py-3 rounded-xl bg-slate-800 border border-slate-600 hover:bg-slate-700 transition-all text-sm font-bold text-slate-200 disabled:opacity-50 flex items-center gap-2"
              >
                {validating ? <Loader2 size={16} className="animate-spin" /> : 'Test'}
              </button>
              <button
                type="button"
                onClick={handleSaveToken}
                disabled={saving || !token}
                className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 transition-all text-sm font-bold disabled:opacity-50 flex items-center gap-2"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : 'Save & Continue'}
              </button>
            </>
          ) : isLastStep ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!name.trim() || submitting}
              className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg transition-all text-sm font-bold disabled:opacity-50 flex items-center gap-2"
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : 'Start Provisioning'}
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              disabled={!canAdvance}
              className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg transition-all text-sm font-bold disabled:opacity-50 flex items-center gap-2"
            >
              Next <ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
