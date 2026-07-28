import { useState, useEffect } from 'react';
import { Cloud, Check, Trash2, Loader2, AlertTriangle, Key, ExternalLink, HardDriveDownload, PlayCircle } from 'lucide-react';

interface ProviderStatus {
  provider: string;
  label: string;
  configured: boolean;
  source?: 'user' | 'env';
  summary?: Record<string, string>;
}

interface ProviderMeta {
  key: string;
  label: string;
  color: string;
  icon: string;
  docsUrl: string;
  fields: { key: string; label: string; sensitive: boolean; placeholder: string; multiline?: boolean }[];
}

// Exported so tests can assert against the real list instead of a hardcoded count that silently
// goes stale (and fails) every time a provider is added.
export const PROVIDERS: ProviderMeta[] = [
  {
    key: 'huggingface',
    label: 'Hugging Face',
    color: '#FFD21E',
    icon: '🤗',
    docsUrl: 'https://huggingface.co/settings/tokens',
    fields: [
      { key: 'hfToken', label: 'Access Token (HF_TOKEN)', sensitive: true, placeholder: 'hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'defaultModel', label: 'Default Model (Optional)', sensitive: false, placeholder: 'meta-llama/Llama-3.2-3B-Instruct' },
    ],
  },
  {
    key: 'github',
    label: 'GitHub',
    color: '#2DA44E',
    icon: '🐙',
    docsUrl: 'https://github.com/settings/tokens',
    fields: [
      { key: 'token', label: 'Personal Access Token', sensitive: true, placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'username', label: 'GitHub Username (Optional)', sensitive: false, placeholder: 'octocat' },
    ],
  },
  {
    key: 'aws',
    label: 'Amazon Web Services',
    color: '#FF9900',
    icon: '☁',
    docsUrl: 'https://console.aws.amazon.com/iam/',
    fields: [
      { key: 'accessKeyId', label: 'Access Key ID', sensitive: false, placeholder: 'AKIAIOSFODNN7EXAMPLE' },
      { key: 'secretAccessKey', label: 'Secret Access Key', sensitive: true, placeholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      { key: 'region', label: 'Default Region', sensitive: false, placeholder: 'us-east-1' },
    ],
  },
  {
    key: 'gcp',
    label: 'Google Cloud Platform',
    color: '#4285F4',
    icon: '◈',
    docsUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    fields: [
      { key: 'projectId', label: 'Project ID', sensitive: false, placeholder: 'my-gcp-project-123' },
      { key: 'serviceAccountJson', label: 'Service Account JSON', sensitive: true, placeholder: '{ "type": "service_account", ... }', multiline: true },
    ],
  },
  {
    key: 'azure',
    label: 'Microsoft Azure',
    color: '#0078D4',
    icon: '◆',
    docsUrl: 'https://portal.azure.com/',
    fields: [
      { key: 'clientId', label: 'Client ID (App ID)', sensitive: false, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'clientSecret', label: 'Client Secret', sensitive: true, placeholder: 'your-client-secret-value' },
      { key: 'subscriptionId', label: 'Subscription ID', sensitive: false, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'tenantId', label: 'Tenant ID', sensitive: false, placeholder: '00000000-0000-0000-0000-000000000000' },
    ],
  },
  {
    key: 'do',
    label: 'DigitalOcean',
    color: '#0080FF',
    icon: '●',
    docsUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    fields: [
      { key: 'token', label: 'API Token', sensitive: true, placeholder: 'dop_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
  },
  {
    key: 'hetzner',
    label: 'Hetzner Cloud',
    color: '#D50C2D',
    icon: '▚',
    // Tokens are per-project in Hetzner Cloud, minted under that project's Security page — there
    // is no account-wide token, so this deep-links to the project list rather than a settings page.
    docsUrl: 'https://console.hetzner.cloud/projects',
    fields: [
      { key: 'token', label: 'API Token (Read & Write)', sensitive: true, placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
  },
  {
    key: 'cloudflare',
    label: 'Cloudflare DNS',
    color: '#F38020',
    icon: '☁',
    // Unlike the others this is not a compute provider — it is only used to manage the platform's
    // own DNS records when standing up or moving the root node. Tenant provisioning never touches
    // it.
    docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    fields: [
      // A *scoped* token, not the Global API Key: Zone → DNS → Edit on the one zone is everything
      // this needs, and the Global Key would grant account-wide access with no way to narrow it.
      { key: 'token', label: 'API Token (Zone → DNS → Edit)', sensitive: true, placeholder: 'scoped token, not the Global API Key' },
      { key: 'zone', label: 'Zone (Optional)', sensitive: false, placeholder: 'nowrinkles.dev' },
    ],
  },
  {
    key: 'vultr',
    label: 'Vultr',
    color: '#007BFC',
    icon: '◆',
    docsUrl: 'https://my.vultr.com/settings/#settingsapi',
    fields: [
      { key: 'token', label: 'Personal Access Token', sensitive: true, placeholder: 'Settings → API → Personal Access Token' },
    ],
  },
  {
    key: 'linode',
    label: 'Linode / Akamai',
    color: '#00A95C',
    icon: '▲',
    docsUrl: 'https://cloud.linode.com/profile/tokens',
    fields: [
      { key: 'token', label: 'Personal Access Token', sensitive: true, placeholder: 'Profile → API Tokens → Create' },
    ],
  },
  {
    key: 'scaleway',
    label: 'Scaleway',
    color: '#4F0599',
    icon: '❯',
    docsUrl: 'https://console.scaleway.com/iam/api-keys',
    fields: [
      // The SECRET key is what authenticates; the access key is only an identifier, which is why
      // it's the optional one here.
      { key: 'secretKey', label: 'Secret Key', sensitive: true, placeholder: 'Shown once when the API key is created' },
      { key: 'accessKey', label: 'Access Key (Optional)', sensitive: false, placeholder: 'SCWXXXXXXXXXXXXXXXXX' },
      { key: 'projectId', label: 'Project ID (Optional)', sensitive: false, placeholder: 'Needed only to create servers, not to browse plans' },
    ],
  },
  {
    key: 'hostinger',
    label: 'Hostinger',
    color: '#673DE6',
    icon: '◇',
    docsUrl: 'https://hpanel.hostinger.com/api-tokens',
    fields: [
      { key: 'token', label: 'API Token', sensitive: true, placeholder: 'hPanel → API tokens (free with any VPS plan)' },
    ],
  },
  {
    key: 'contabo',
    label: 'Contabo',
    color: '#0A5FA5',
    icon: '▣',
    docsUrl: 'https://my.contabo.com/api/details',
    fields: [
      // Contabo is the only provider here using an OAuth2 password grant rather than one token.
      { key: 'clientId', label: 'Client ID', sensitive: true, placeholder: 'API → Details → Client ID' },
      { key: 'clientSecret', label: 'Client Secret', sensitive: true, placeholder: 'API → Details → Client Secret' },
      { key: 'apiUser', label: 'API User (email)', sensitive: false, placeholder: 'your@email.com' },
      { key: 'apiPassword', label: 'API Password', sensitive: true, placeholder: 'Set under API → Details (not your login password)' },
    ],
  },
];

// Providers this platform can actually create a cluster on today, in the order the cluster
// wizard offers them. Everything else in PROVIDERS above is a credential store only (or, for
// aws/gcp/azure/do, still the stubbed scaffolding the distributed-systems plan describes).
export const CLUSTER_CAPABLE_PROVIDERS = ['hetzner'] as const;

/**
 * What connecting each VPS provider actually gets you today, shown on the card so the value is
 * clear before someone goes hunting for a token — and so nobody expects Contabo plans to appear
 * in the catalog when its API publishes no prices at all.
 */
export const PROVIDER_CAPABILITY: Record<string, string> = {
  hetzner: 'Live plan prices in the VPS Catalog, and full cluster provisioning.',
  vultr: 'Vultr plans are already in the VPS Catalog (public API) — a token is only needed for future provisioning.',
  linode: 'Linode plans are already in the VPS Catalog (public API) — a token is only needed for future provisioning.',
  scaleway: 'Scaleway plans are already in the VPS Catalog (public API) — a token is only needed for future provisioning.',
  do: 'Adds DigitalOcean plan prices to the VPS Catalog.',
  hostinger: 'Adds Hostinger plans to the VPS Catalog once the adapter is verified against a real token.',
  contabo: 'Management access only — Contabo publishes no pricing API, so its plans cannot appear in the VPS Catalog.',
};

interface GoogleDriveStatus {
  email?: string;
  backupPassword?: string; // masked, e.g. "****"
}

export default function CloudAccounts({ apiBase }: { apiBase: string }) {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [driveStatus, setDriveStatus] = useState<GoogleDriveStatus | null>(null);
  const [driveLoading, setDriveLoading] = useState(true);
  const [driveNotice, setDriveNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [backupPasswordInput, setBackupPasswordInput] = useState('');
  const [savingBackupPassword, setSavingBackupPassword] = useState(false);
  const [testingDrive, setTestingDrive] = useState(false);
  const [driveTestResult, setDriveTestResult] = useState<{ valid?: boolean; message?: string } | null>(null);
  const [confirmDisconnectDrive, setConfirmDisconnectDrive] = useState(false);
  const [runningBackup, setRunningBackup] = useState(false);
  const [backupOutput, setBackupOutput] = useState<{ success: boolean; output: string } | null>(null);

  const fetchDriveStatus = async () => {
    try {
      const res = await fetch(`${apiBase}/credentials/googledrive`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setDriveStatus(data.credentials || null);
      }
    } catch (err) {
      console.error('Failed to fetch Google Drive status', err);
    } finally {
      setDriveLoading(false);
    }
  };

  const handleSaveBackupPassword = async () => {
    setSavingBackupPassword(true);
    try {
      const res = await fetch(`${apiBase}/credentials/googledrive`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ backupPassword: backupPasswordInput }),
      });
      if (res.ok) {
        setBackupPasswordInput('');
        await fetchDriveStatus();
        setDriveNotice({ kind: 'success', message: 'Backup encryption password saved.' });
      }
    } catch (err) {
      console.error('Failed to save backup password', err);
    } finally {
      setSavingBackupPassword(false);
    }
  };

  const handleTestDrive = async () => {
    setTestingDrive(true);
    setDriveTestResult(null);
    try {
      const res = await fetch(`${apiBase}/credentials/validate/googledrive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setDriveTestResult({ valid: data.valid, message: data.message });
    } catch (err: any) {
      setDriveTestResult({ valid: false, message: `Validation failed: ${err.message}` });
    } finally {
      setTestingDrive(false);
    }
  };

  const handleDisconnectDrive = async () => {
    try {
      const res = await fetch(`${apiBase}/credentials/googledrive`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        setConfirmDisconnectDrive(false);
        setDriveTestResult(null);
        await fetchDriveStatus();
      }
    } catch (err) {
      console.error('Failed to disconnect Google Drive', err);
    }
  };

  const handleRunBackupNow = async () => {
    setRunningBackup(true);
    setBackupOutput(null);
    try {
      const res = await fetch(`${apiBase}/backup/run`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      setBackupOutput(data);
    } catch (err: any) {
      setBackupOutput({ success: false, output: err.message });
    } finally {
      setRunningBackup(false);
    }
  };

  const fetchStatuses = async () => {
    try {
      const res = await fetch(`${apiBase}/credentials`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setStatuses(data.providers || []);
      }
    } catch (err) {
      console.error('Failed to fetch credential statuses', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatuses();
  }, []);

  useEffect(() => {
    // Deliberately a separate effect from fetchStatuses above, firing after it: Drive is not
    // part of the same provider grid/status shape, and letting its fetch fail independently
    // (e.g. backend not yet supporting it) shouldn't block the main provider grid from loading.
    fetchDriveStatus();
    // The OAuth callback redirects back here with ?driveConnected=1 or ?driveError=... —
    // surface it once, then scrub the URL so a refresh doesn't re-show the same toast.
    const params = new URLSearchParams(window.location.search);
    if (params.get('driveConnected')) {
      setDriveNotice({ kind: 'success', message: 'Google Drive connected.' });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('driveError')) {
      const code = params.get('driveError')!;
      const message = code === 'missing_client_id'
        ? 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in apps/backend/.env.'
        : code === 'no_refresh_token'
        ? 'Google didn\'t return a refresh token — revoke this app\'s access at myaccount.google.com/permissions and try connecting again.'
        : `Connection failed: ${decodeURIComponent(code)}`;
      setDriveNotice({ kind: 'error', message });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const [validating, setValidating] = useState(false);
  const [valResult, setValResult] = useState<{ valid?: boolean; message?: string } | null>(null);

  const handleTestConnection = async (providerKey: string) => {
    setValidating(true);
    setValResult(null);
    try {
      const res = await fetch(`${apiBase}/credentials/validate/${providerKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      setValResult({ valid: data.valid, message: data.message });
    } catch (err: any) {
      setValResult({ valid: false, message: `Validation failed: ${err.message}` });
    } finally {
      setValidating(false);
    }
  };

  const handleConfigure = (providerKey: string) => {
    setExpandedProvider(providerKey);
    setFormData({});
    setSaveSuccess(null);
    setValResult(null);
  };

  const handleCancel = () => {
    setExpandedProvider(null);
    setFormData({});
    setValResult(null);
  };

  const handleSave = async (providerKey: string) => {
    setSaving(true);
    setSaveSuccess(null);
    try {
      const res = await fetch(`${apiBase}/credentials/${providerKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        setSaveSuccess(providerKey);
        setExpandedProvider(null);
        setFormData({});
        await fetchStatuses();
        setTimeout(() => setSaveSuccess(null), 3000);
      }
    } catch (err) {
      console.error('Failed to save credentials', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (providerKey: string) => {
    setDeleting(providerKey);
    try {
      const res = await fetch(`${apiBase}/credentials/${providerKey}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setConfirmDelete(null);
        await fetchStatuses();
      }
    } catch (err) {
      console.error('Failed to delete credentials', err);
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <section>
      <header className="mb-10">
        <h2 className="text-3xl font-bold flex items-center gap-3">
          <Key className="text-blue-500" size={28} />
          Cloud Accounts
        </h2>
        <p className="text-slate-400 mt-2">
          Connect your cloud provider credentials to deploy infrastructure beyond local k3d clusters.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-4xl">
        {PROVIDERS.map((provider) => {
          const status = statuses.find((s) => s.provider === provider.key);
          const isConfigured = status?.configured ?? false;
          const isExpanded = expandedProvider === provider.key;
          const isDeleting = deleting === provider.key;
          const justSaved = saveSuccess === provider.key;

          return (
            <div
              key={provider.key}
              className={`
                relative bg-slate-800 border rounded-3xl overflow-hidden transition-all duration-300
                ${isConfigured ? 'border-slate-600' : 'border-slate-700/50'}
                ${isExpanded ? 'col-span-1 xl:col-span-2' : ''}
                ${justSaved ? 'ring-2 ring-green-500/50' : ''}
              `}
            >
              {/* Accent bar */}
              <div
                className="h-1 w-full"
                style={{ backgroundColor: isConfigured ? provider.color : 'transparent' }}
              />

              <div className="p-6">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span
                      className="text-2xl w-10 h-10 flex items-center justify-center rounded-xl"
                      style={{ backgroundColor: `${provider.color}15`, color: provider.color }}
                    >
                      {provider.icon}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-white text-lg">{provider.label}</h3>
                        <a
                          href={provider.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-500 hover:text-slate-300 transition-colors"
                          title="Get API Token / Credentials"
                        >
                          <ExternalLink size={14} />
                        </a>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {isConfigured ? (
                          <>
                            <div className="w-2 h-2 rounded-full bg-green-500" />
                            <span className="text-xs text-green-400 font-semibold">
                              Connected
                              {status?.source === 'env' && (
                                <span className="text-slate-500 ml-1">(via environment)</span>
                              )}
                            </span>
                          </>
                        ) : (
                          <>
                            <div className="w-2 h-2 rounded-full bg-slate-500" />
                            <span className="text-xs text-slate-500 font-semibold">Not Configured</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {justSaved && (
                    <div className="flex items-center gap-1 text-green-400 text-sm font-bold animate-in fade-in">
                      <Check size={16} /> Saved
                    </div>
                  )}
                </div>

                {/* What connecting this provider actually gets you — stated before the user goes
                    off to find a token, and honest where the answer is "not much yet". */}
                {PROVIDER_CAPABILITY[provider.key] && !isExpanded && (
                  <p className="text-[11px] text-slate-500 leading-relaxed mb-3">
                    {PROVIDER_CAPABILITY[provider.key]}
                  </p>
                )}

                {/* Configured summary */}
                {isConfigured && !isExpanded && status?.summary && status.source === 'user' && (
                  <div className="space-y-1 mb-4">
                    {Object.entries(status.summary).map(([key, value]) => (
                      <div key={key} className="flex items-center gap-2 text-xs">
                        <span className="text-slate-500 font-mono min-w-[160px]">{key}</span>
                        <span className="text-slate-300 font-mono">{value}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Actions */}
                {!isExpanded && (
                  <div className="flex gap-3 mt-4">
                    {isConfigured && status?.source === 'user' ? (
                      <>
                        <button
                          onClick={() => handleConfigure(provider.key)}
                          className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-700/50 hover:bg-slate-700 transition-all text-slate-300"
                        >
                          Edit Credentials
                        </button>
                        <button
                          onClick={() => setConfirmDelete(provider.key)}
                          className="py-2.5 px-4 text-sm font-bold rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all"
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    ) : isConfigured && status?.source === 'env' ? (
                      <div className="flex-1 py-2.5 px-4 text-xs text-slate-500 bg-slate-900/30 rounded-xl text-center">
                        Managed via environment variables
                      </div>
                    ) : (
                      <button
                        onClick={() => handleConfigure(provider.key)}
                        className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl transition-all text-white"
                        style={{ backgroundColor: `${provider.color}30`, color: provider.color }}
                      >
                        Configure
                      </button>
                    )}
                  </div>
                )}

                {/* Expanded form */}
                {isExpanded && (
                  <div className="mt-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
                    <div className="bg-slate-900/40 rounded-2xl p-6 border border-white/5 space-y-4">
                      {provider.fields.map((field) => (
                        <div key={field.key}>
                          <div className="flex justify-between items-center mb-2">
                            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                              {field.label}
                            </label>
                            {field.sensitive && (
                              <a
                                href={provider.docsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                              >
                                Get key <ExternalLink size={10} />
                              </a>
                            )}
                          </div>
                          {field.multiline ? (
                            <textarea
                              rows={5}
                              placeholder={field.placeholder}
                              value={formData[field.key] || ''}
                              onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                              className="block w-full px-4 py-3 bg-slate-800/50 border border-white/5 rounded-xl text-white font-mono text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                            />
                          ) : (
                            <input
                              type={field.sensitive ? 'password' : 'text'}
                              placeholder={field.placeholder}
                              value={formData[field.key] || ''}
                              onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                              className="block w-full px-4 py-3 bg-slate-800/50 border border-white/5 rounded-xl text-white font-mono text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                            />
                          )}
                        </div>
                      ))}

                      {valResult && (
                        <div
                          className={`p-3 rounded-xl text-xs font-semibold flex items-center gap-2 ${
                            valResult.valid
                              ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                              : 'bg-red-500/10 border border-red-500/20 text-red-400'
                          }`}
                        >
                          {valResult.valid ? <Check size={14} /> : <AlertTriangle size={14} />}
                          <span>{valResult.message}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={handleCancel}
                        className="flex-1 py-3 px-4 text-sm font-bold rounded-xl bg-slate-700/50 hover:bg-slate-700 transition-all text-slate-300"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestConnection(provider.key)}
                        disabled={validating}
                        className="flex-1 py-3 px-4 text-sm font-bold rounded-xl bg-slate-800 border border-slate-600 hover:bg-slate-700 transition-all text-slate-200 disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {validating ? <Loader2 size={16} className="animate-spin" /> : 'Test Connection'}
                      </button>
                      <button
                        onClick={() => handleSave(provider.key)}
                        disabled={saving}
                        className="flex-1 py-3 px-4 text-sm font-bold rounded-xl transition-all text-white disabled:opacity-50"
                        style={{ backgroundColor: provider.color }}
                      >
                        {saving ? (
                          <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                        ) : (
                          'Save & Encrypt'
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Delete confirmation overlay */}
              {confirmDelete === provider.key && (
                <div className="absolute inset-0 bg-slate-900/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-10 animate-in fade-in duration-150">
                  <AlertTriangle className="text-red-500 mb-3" size={32} />
                  <h4 className="font-bold text-lg mb-1">Remove Credentials?</h4>
                  <p className="text-slate-400 text-sm text-center mb-6">
                    This provider will revert to Mock Cloud Mode.
                  </p>
                  <div className="flex gap-3 w-full max-w-xs">
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-700 hover:bg-slate-600 transition-all"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleDelete(provider.key)}
                      disabled={isDeleting}
                      className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-red-600 hover:bg-red-500 transition-all"
                    >
                      {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Remove'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Mock Cloud Mode info */}
      <div className="mt-8 max-w-4xl bg-blue-500/5 border border-blue-500/20 rounded-2xl p-5 flex items-start gap-4">
        <Cloud className="text-blue-500 flex-shrink-0 mt-0.5" size={20} />
        <div>
          <h4 className="text-sm font-bold text-blue-400 mb-1">Mock Cloud Mode</h4>
          <p className="text-xs text-slate-400 leading-relaxed">
            Providers without configured credentials automatically run in Mock Cloud Mode,
            using local k3d containers for zero-setup development. Configure real credentials
            above to deploy to actual cloud infrastructure.
          </p>
        </div>
      </div>

      {/* ── Backup Destinations ── */}
      <header className="mt-14 mb-6 max-w-4xl">
        <h2 className="text-2xl font-bold flex items-center gap-3">
          <HardDriveDownload className="text-blue-500" size={24} />
          Backup Destinations
        </h2>
        <p className="text-slate-400 mt-2 text-sm">
          Where MongoDB, deployed apps' persistent data, and encrypted secrets get backed up.
          Runs daily via a systemd timer, or on demand below.
        </p>
      </header>

      {driveNotice && (
        <div className={`max-w-4xl mb-4 p-4 rounded-2xl text-sm font-semibold flex items-center gap-2 ${
          driveNotice.kind === 'success' ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'
        }`}>
          {driveNotice.kind === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />}
          <span>{driveNotice.message}</span>
        </div>
      )}

      <div className="max-w-4xl bg-slate-800 border border-slate-700/50 rounded-3xl overflow-hidden relative">
        <div className="h-1 w-full" style={{ backgroundColor: driveStatus?.email ? '#4285F4' : 'transparent' }} />
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl w-10 h-10 flex items-center justify-center rounded-xl" style={{ backgroundColor: '#4285F415', color: '#4285F4' }}>
                ◈
              </span>
              <div>
                <h3 className="font-bold text-white text-lg">Google Drive</h3>
                <div className="flex items-center gap-2 mt-0.5">
                  {driveLoading ? (
                    <span className="text-xs text-slate-500 font-semibold">Checking...</span>
                  ) : driveStatus?.email ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-xs text-green-400 font-semibold">Connected as {driveStatus.email}</span>
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 rounded-full bg-slate-500" />
                      <span className="text-xs text-slate-500 font-semibold">Not Connected</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {!driveLoading && !driveStatus?.email && (
            <>
              <p className="text-xs text-slate-500 mb-4 leading-relaxed">
                Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in apps/backend/.env (Drive API enabled,
                with http://localhost:3001/api/credentials/googledrive/callback added as an authorized
                redirect URI in Google Cloud Console).
              </p>
              <a
                href={`${apiBase}/credentials/googledrive/connect`}
                className="inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm font-bold rounded-xl transition-all text-white"
                style={{ backgroundColor: '#4285F430', color: '#4285F4' }}
              >
                Connect with Google
              </a>
            </>
          )}

          {!driveLoading && driveStatus?.email && (
            <div className="space-y-4">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Backup Encryption Password
                  </label>
                  {driveStatus.backupPassword && (
                    <span className="text-[11px] text-green-400 font-semibold flex items-center gap-1"><Check size={12} /> Set</span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 mb-2">
                  Protects apps/backend/.env in transit and at rest on Drive — losing this password means losing that specific backup (Mongo and app data aren't affected).
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder={driveStatus.backupPassword ? 'Enter a new password to change it' : 'Choose a password'}
                    value={backupPasswordInput}
                    onChange={(e) => setBackupPasswordInput(e.target.value)}
                    className="flex-1 px-4 py-2.5 bg-slate-800/50 border border-white/5 rounded-xl text-white font-mono text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleSaveBackupPassword}
                    disabled={savingBackupPassword || !backupPasswordInput}
                    className="py-2.5 px-4 text-sm font-bold rounded-xl bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 transition-all disabled:opacity-50"
                  >
                    {savingBackupPassword ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
                  </button>
                </div>
              </div>

              {driveTestResult && (
                <div className={`p-3 rounded-xl text-xs font-semibold flex items-center gap-2 ${
                  driveTestResult.valid ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'
                }`}>
                  {driveTestResult.valid ? <Check size={14} /> : <AlertTriangle size={14} />}
                  <span>{driveTestResult.message}</span>
                </div>
              )}

              {backupOutput && (
                <div className={`p-3 rounded-xl text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto ${
                  backupOutput.success ? 'bg-green-500/5 border border-green-500/20 text-green-300' : 'bg-red-500/5 border border-red-500/20 text-red-300'
                }`}>
                  {backupOutput.output || (backupOutput.success ? 'Backup complete.' : 'Backup failed.')}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmDisconnectDrive(true)}
                  className="py-2.5 px-4 text-sm font-bold rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all flex items-center gap-2"
                >
                  <Trash2 size={16} /> Disconnect
                </button>
                <button
                  onClick={handleTestDrive}
                  disabled={testingDrive}
                  className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-800 border border-slate-600 hover:bg-slate-700 transition-all text-slate-200 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {testingDrive ? <Loader2 size={16} className="animate-spin" /> : 'Test Connection'}
                </button>
                <button
                  onClick={handleRunBackupNow}
                  disabled={runningBackup}
                  className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl transition-all text-white disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ backgroundColor: '#4285F4' }}
                >
                  {runningBackup ? <Loader2 size={16} className="animate-spin" /> : <><PlayCircle size={16} /> Run Backup Now</>}
                </button>
              </div>
            </div>
          )}
        </div>

        {confirmDisconnectDrive && (
          <div className="absolute inset-0 bg-slate-900/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-10 animate-in fade-in duration-150">
            <AlertTriangle className="text-red-500 mb-3" size={32} />
            <h4 className="font-bold text-lg mb-1">Disconnect Google Drive?</h4>
            <p className="text-slate-400 text-sm text-center mb-6">
              Removes the stored refresh token and backup password. Existing backups already on Drive aren't deleted.
            </p>
            <div className="flex gap-3 w-full max-w-xs">
              <button onClick={() => setConfirmDisconnectDrive(false)} className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-700 hover:bg-slate-600 transition-all">
                Cancel
              </button>
              <button onClick={handleDisconnectDrive} className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-red-600 hover:bg-red-500 transition-all">
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
