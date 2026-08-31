import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Cloud, Check, Trash2, Loader2, AlertTriangle, Key, ExternalLink, Sparkles } from 'lucide-react';
import {
  credentialKeys, listProviders, saveCredentials, deleteCredentials, validateCredentials,
} from '../api/credentials';
import { errorMessage } from '../api/client';
import type { ValidationResult } from '../types/credentials';
import { PROVIDERS, LLM_PROVIDERS, PROVIDER_CAPABILITY } from './credential-providers';
import GoogleDriveCard from './GoogleDriveCard';
import { driveNoticeFrom } from '../lib/drive-notice';
import {
  listLlmProviders, saveLlmCredentials, deleteLlmCredentials,
  type LlmProviderStatus,
} from '../api/credentials';

export default function CloudAccounts() {
  const qc = useQueryClient();

  const providersQuery = useQuery({ queryKey: credentialKeys.list(), queryFn: listProviders });
  const llmQuery = useQuery({ queryKey: ['credentials', 'llm'], queryFn: listLlmProviders });

  const statuses = providersQuery.data ?? [];
  const llmStatuses: LlmProviderStatus[] = llmQuery.data ?? [];
  const loading = providersQuery.isPending || llmQuery.isPending;

  const refresh = () => qc.invalidateQueries({ queryKey: credentialKeys.all });

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [valResult, setValResult] = useState<ValidationResult | null>(null);

  const save = useMutation({
    mutationFn: (v: { provider: string; values: Record<string, string> }) =>
      saveCredentials(v.provider, v.values),
    onSuccess: async (_d, v) => {
      await refresh();
      setSaveSuccess(v.provider);
      setExpandedProvider(null);
      setFormData({});
      setTimeout(() => setSaveSuccess(null), 3000);
    },
  });

  const remove = useMutation({
    mutationFn: (provider: string) => deleteCredentials(provider),
    onSuccess: async () => { await refresh(); setConfirmDelete(null); },
  });

  const validate = useMutation({
    mutationFn: (v: { provider: string; values: Record<string, string> }) =>
      validateCredentials(v.provider, v.values),
    onSuccess: (result) => setValResult(result),
    onError: (err) => setValResult({ valid: false, message: errorMessage(err) }),
  });

  useEffect(() => {
    if (driveNoticeFrom(window.location.search)) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const saving = save.isPending;
  const deleting = remove.isPending ? remove.variables : null;
  const validating = validate.isPending;

  // LLM provider state (separate from cloud providers)
  const [llmExpanded, setLlmExpanded] = useState<string | null>(null);
  const [llmForm, setLlmForm] = useState<Record<string, string>>({});
  const [llmConfirmDelete, setLlmConfirmDelete] = useState<string | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const llmRefresh = () => qc.invalidateQueries({ queryKey: ['credentials', 'llm'] });

  const saveLlm = useMutation({
    mutationFn: (data: { provider: string; apiKey?: string; baseUrl?: string; model?: string }) =>
      saveLlmCredentials(data),
    onSuccess: () => {
      llmRefresh();
      setLlmExpanded(null);
      setLlmForm({});
      setLlmError(null);
    },
    onError: (err) => setLlmError(errorMessage(err)),
  });

  const removeLlm = useMutation({
    mutationFn: (provider: string) => deleteLlmCredentials(provider),
    onSuccess: () => { llmRefresh(); setLlmConfirmDelete(null); },
    onError: (err) => setLlmError(errorMessage(err)),
  });

  const handleTestConnection = (providerKey: string) => {
    setValResult(null);
    validate.mutate({ provider: providerKey, values: formData });
  };

  const handleConfigure = (providerKey: string) => {
    setExpandedProvider(providerKey);
    setFormData({});
    setValResult(null);
  };

  const handleCancel = () => {
    setExpandedProvider(null);
    setFormData({});
    setValResult(null);
  };

  const handleSave = (providerKey: string) => save.mutate({ provider: providerKey, values: formData });
  const handleDelete = (providerKey: string) => remove.mutate(providerKey);

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
              <div
                className="h-1 w-full"
                style={{ backgroundColor: isConfigured ? provider.color : 'transparent' }}
              />

              <div className="p-6">
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

                {PROVIDER_CAPABILITY[provider.key] && !isExpanded && (
                  <p className="text-[11px] text-slate-500 leading-relaxed mb-3">
                    {PROVIDER_CAPABILITY[provider.key]}
                  </p>
                )}

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

      <GoogleDriveCard />

      {/* LLM Providers */}
      <div className="mt-16">
        <header className="mb-8">
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="text-purple-400" size={22} />
            LLM Providers
          </h2>
          <p className="text-slate-400 text-sm mt-1">Connect AI model providers for chat, planning, and coding.</p>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-4xl">
          {LLM_PROVIDERS.map((provider) => {
            const status = llmStatuses.find((s) => s.provider === provider.key);
            const isConfigured = (status?.modelCount ?? 0) > 0 || !!status?.hasKey;
            const isExpanded = llmExpanded === provider.key;

            return (
              <div
                key={provider.key}
                className={`relative bg-slate-800 border rounded-3xl overflow-hidden transition-all duration-300 ${
                  isExpanded ? 'col-span-1 xl:col-span-2' : ''
                } ${isConfigured ? 'border-slate-600' : 'border-slate-700/50'}`}
              >
                <div className="h-1 w-full" style={{ backgroundColor: isConfigured ? provider.color : 'transparent' }} />

                <div className="p-6">
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
                          {provider.docsUrl && (
                            <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-300" title="Get API Key">
                              <ExternalLink size={14} />
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {isConfigured ? (
                            <>
                              <div className="w-2 h-2 rounded-full bg-green-500" />
                              <span className="text-xs text-green-400 font-semibold">
                                {status?.modelCount ?? 0} model{(status?.modelCount ?? 0) !== 1 ? 's' : ''} connected
                              </span>
                            </>
                          ) : (
                            <>
                              <div className="w-2 h-2 rounded-full bg-slate-500" />
                              <span className="text-xs text-slate-500 font-semibold">Not configured</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {!isExpanded && (
                    <div className="flex gap-3 mt-4">
                      {isConfigured ? (
                        <>
                          <button onClick={() => { setLlmExpanded(provider.key); setLlmForm({}); setLlmError(null); }}
                            className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-700/50 hover:bg-slate-700 text-slate-300">
                            Change Key
                          </button>
                          <button onClick={() => setLlmConfirmDelete(provider.key)}
                            className="py-2.5 px-4 text-sm font-bold rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400">
                            <Trash2 size={16} />
                          </button>
                        </>
                      ) : (
                        <button onClick={() => { setLlmExpanded(provider.key); setLlmForm({}); setLlmError(null); }}
                          className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl text-white"
                          style={{ backgroundColor: `${provider.color}30`, color: provider.color }}>
                          Configure
                        </button>
                      )}
                    </div>
                  )}

                  {isExpanded && (
                    <div className="mt-4 space-y-4">
                      <div className="bg-slate-900/40 rounded-2xl p-6 border border-white/5 space-y-4">
                        {provider.fields.map((field) => (
                          <div key={field.key}>
                            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                              {field.label}
                            </label>
                            <input
                              type={field.sensitive ? 'password' : 'text'}
                              placeholder={field.placeholder}
                              value={llmForm[field.key] || ''}
                              onChange={(e) => setLlmForm({ ...llmForm, [field.key]: e.target.value })}
                              className="block w-full px-4 py-3 bg-slate-800/50 border border-white/5 rounded-xl text-white font-mono text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                            />
                          </div>
                        ))}

                        {llmError && (
                          <div className="p-3 rounded-xl text-xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400 flex items-center gap-2">
                            <AlertTriangle size={14} />
                            <span>{llmError}</span>
                          </div>
                        )}
                      </div>

                      <div className="flex gap-3">
                        <button onClick={() => setLlmExpanded(null)}
                          className="flex-1 py-3 px-4 text-sm font-bold rounded-xl bg-slate-700/50 hover:bg-slate-700 text-slate-300">
                          Cancel
                        </button>
                        <button onClick={() => saveLlm.mutate({ provider: provider.key, ...llmForm })}
                          disabled={saveLlm.isPending}
                          className="flex-1 py-3 px-4 text-sm font-bold rounded-xl transition-all text-white disabled:opacity-50"
                          style={{ backgroundColor: provider.color }}>
                          {saveLlm.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Connect & Fetch Models'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {llmConfirmDelete === provider.key && (
                  <div className="absolute inset-0 bg-slate-900/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-10">
                    <AlertTriangle className="text-red-500 mb-3" size={32} />
                    <h4 className="font-bold text-lg mb-1">Remove {provider.label}?</h4>
                    <p className="text-slate-400 text-sm text-center mb-6">All models from this provider will be removed from your model list.</p>
                    <div className="flex gap-3 w-full max-w-xs">
                      <button onClick={() => setLlmConfirmDelete(null)}
                        className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-700 hover:bg-slate-600">Cancel</button>
                      <button onClick={() => removeLlm.mutate(provider.key)} disabled={removeLlm.isPending}
                        className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-red-600 hover:bg-red-500">
                        {removeLlm.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Remove'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
