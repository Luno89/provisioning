import { useState, useEffect } from 'react';
import { Cloud, Check, Trash2, Loader2, AlertTriangle, Key, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

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
  fields: { key: string; label: string; sensitive: boolean; placeholder: string; multiline?: boolean }[];
}

const PROVIDERS: ProviderMeta[] = [
  {
    key: 'aws',
    label: 'Amazon Web Services',
    color: '#FF9900',
    icon: '☁',
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
    fields: [
      { key: 'token', label: 'API Token', sensitive: true, placeholder: 'dop_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
  },
];

export default function CloudAccounts({ apiBase }: { apiBase: string }) {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

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

  const handleConfigure = (providerKey: string) => {
    setExpandedProvider(providerKey);
    setFormData({});
    setSaveSuccess(null);
  };

  const handleCancel = () => {
    setExpandedProvider(null);
    setFormData({});
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
                      <h3 className="font-bold text-white text-lg">{provider.label}</h3>
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
                          <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                            {field.label}
                          </label>
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
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={handleCancel}
                        className="flex-1 py-3 px-4 text-sm font-bold rounded-xl bg-slate-700/50 hover:bg-slate-700 transition-all text-slate-300"
                      >
                        Cancel
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
    </section>
  );
}
