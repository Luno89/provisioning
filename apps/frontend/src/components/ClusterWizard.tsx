import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, AlertTriangle, Loader2, ExternalLink, KeyRound } from 'lucide-react';

/**
 * Multi-step "Provision New Cluster" flow.
 *
 * Extracted from App.tsx rather than grown in place: the credentials step needs its own
 * validate/save round-trips and local state, which is exactly the kind of thing that made
 * App.tsx a ~1800-line monolith in the first place.
 *
 * The credentials step exists because a real-VM provider is unusable without a token, and
 * bouncing the user out to the Cloud Accounts page mid-flow (and losing the half-filled form)
 * is a worse experience than asking for the token right where it's first needed. It is skipped
 * entirely when the provider needs no credentials (k3d) or already has them configured.
 */

export interface ProviderOption {
  value: string;
  label: string;
  /** Credential provider key this cluster provider needs, if any. */
  credentialKey?: string;
  hint?: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  { value: 'k3d', label: 'Local Datacenter (k3d)', hint: 'Runs on this machine. No credentials, no cost.' },
  {
    value: 'hetzner',
    label: 'Hetzner Cloud (VPS)',
    credentialKey: 'hetzner',
    hint: 'Creates a real VM, installs k3s on it over SSH, and bills to your Hetzner project.',
  },
];

// Hetzner's current x86 lineup. The previous generation (cx22/cx32/cx42) has been superseded by
// CX23/33/43/53 and is no longer orderable, so those values now fail at create time.
//
// CAX plans are deliberately absent: they are ARM64, and several images this platform deploys
// (notably game servers running SteamCMD) are x86-64 only. A user picking one to save money would
// get a cluster that provisions fine and then fails every app deploy with an exec-format error.
//
// Anything below 8 GB is also absent — k3s plus this platform's own cluster stack
// (kube-prometheus-stack, Traefik, Loki) measures at a ~5 GB working set, so a 4 GB plan leaves no
// usable headroom. See tests/lib/memory-budget.ts for where that number comes from.
const HETZNER_SERVER_TYPES = [
  { value: 'cx33', label: 'CX33 — 4 vCPU / 8 GB' },
  { value: 'cx43', label: 'CX43 — 8 vCPU / 16 GB' },
  { value: 'cx53', label: 'CX53 — 16 vCPU / 32 GB (default)' },
  { value: 'ccx23', label: 'CCX23 — 4 dedicated vCPU / 16 GB' },
  { value: 'ccx33', label: 'CCX33 — 8 dedicated vCPU / 32 GB' },
];

const HETZNER_LOCATIONS = [
  { value: 'nbg1', label: 'Nuremberg, Germany (nbg1)' },
  { value: 'fsn1', label: 'Falkenstein, Germany (fsn1)' },
  { value: 'hel1', label: 'Helsinki, Finland (hel1)' },
  { value: 'ash', label: 'Ashburn, VA, USA (ash)' },
  { value: 'hil', label: 'Hillsboro, OR, USA (hil)' },
  { value: 'sin', label: 'Singapore (sin)' },
];

interface Props {
  apiBase: string;
  /** From GET /api/credentials — used to skip the token step when one is already stored. */
  configuredProviders: { provider: string; configured: boolean }[];
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  submitting?: boolean;
  /** Re-fetches the credential statuses after a token is saved. */
  onCredentialsSaved?: () => void;
}

export default function ClusterWizard({
  apiBase,
  configuredProviders,
  onCancel,
  onSubmit,
  submitting,
  onCredentialsSaved,
}: Props) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('k3d');

  const [token, setToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tokenResult, setTokenResult] = useState<{ valid?: boolean; message?: string } | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);

  const [serverType, setServerType] = useState('cx53');
  const [location, setLocation] = useState('nbg1');

  const selected = PROVIDER_OPTIONS.find((p) => p.value === provider)!;
  const credentialKey = selected.credentialKey;
  const alreadyConfigured = !!credentialKey && configuredProviders.some((p) => p.provider === credentialKey && p.configured);

  // The token step is skipped when there's nothing to ask for — but only *skipped*, never
  // removed: `needsCredentialStep` is recomputed as the provider changes, so going back and
  // switching from k3d to Hetzner re-introduces it.
  const needsCredentialStep = !!credentialKey && !alreadyConfigured && !tokenSaved;
  const needsOptionsStep = provider === 'hetzner';

  const steps = [1, ...(needsCredentialStep ? [2] : []), ...(needsOptionsStep ? [3] : [])];
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
      const res = await fetch(`${apiBase}/credentials/validate/${credentialKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      setTokenResult({ valid: data.valid, message: data.message });
    } catch (err: any) {
      setTokenResult({ valid: false, message: `Validation failed: ${err.message}` });
    } finally {
      setValidating(false);
    }
  };

  const handleSaveToken = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/credentials/${credentialKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setTokenSaved(true);
        setToken('');
        onCredentialsSaved?.();
        setStep(needsOptionsStep ? 3 : 1);
      } else {
        const data = await res.json().catch(() => ({}));
        setTokenResult({ valid: false, message: data.error || `Could not save token (HTTP ${res.status}).` });
      }
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
      ...(provider === 'hetzner' ? { hetznerServerType: serverType, hetznerLocation: location } : {}),
    });
  };

  const canAdvance = step === 1 ? name.trim().length > 0 : true;

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
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 transition-all text-sm"
                placeholder="e.g. production-omega"
              />
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
                {PROVIDER_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              {selected.hint && <p className="text-[11px] text-slate-500 mt-2 px-1">{selected.hint}</p>}
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
                <h4 className="font-bold text-white">{selected.label} API Token</h4>
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
                {HETZNER_SERVER_TYPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-2 px-1">
                k3s plus the cluster stack (Prometheus, Grafana, Traefik, Loki) uses ~5 GB before
                any app is deployed, so size for that plus whatever you plan to run.
              </p>
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
                {HETZNER_LOCATIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
              <AlertTriangle className="text-amber-500 flex-shrink-0 mt-0.5" size={16} />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                This creates a real, billable server in your Hetzner project. Destroying the cluster
                from this UI deletes the server and verifies it against Hetzner's API.
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
