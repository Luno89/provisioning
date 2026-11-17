import { TypedTag } from './TypedTag';
import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Blocks, Box, Check, ChevronDown, ChevronUp, Database, Layers, Loader2, Package, X, Zap } from 'lucide-react';
import { useHfModelSize, useModelSearch, useTabbyImageTags, useHfBranches } from '../../../models';
import { TagPicker } from './TagPicker';
import { VllmToolCalling } from '../VllmToolCalling';
import { toolCallingBlocks } from '../../lib/vllm-tool-calling';
import { useVllmToolCalling } from '../../hooks/useVllmToolCalling';
import { useDebounce } from '../../../../shared/lib/use-debounce';
import { credentialKeys, listProviders } from '../../api/credentials';
import { useAppCatalogue, type AppUiDefaults, type AppImageDefaults } from '../../api/deployments';
import { EMPTY_WIZARD_DATA, type WizardData } from '../../lib/wizard-defaults';
import { deployPayloadOf } from '../../lib/deploy-payload';
import { errorMessage } from '../../../../api/client';
import { chosenGpus, gpuChoicesOf, type GpuChoices, type GpuVendor } from '../../lib/gpu-choices';
import { nextStep, prevStep, isModelApp } from './steps';
import type { Cluster } from '../../types/cluster';
import type { Deployment } from '../../types/deployment';
import { deployableTo, reportsGpu, targetLabel } from '../../lib/deploy-targets'

const BLANK_IMAGE: AppImageDefaults = { webRepo: '', webTag: '', dbRepo: '', dbTag: '' };
const EMPTY_UI_DEFAULTS: AppUiDefaults = { helm: BLANK_IMAGE, native: BLANK_IMAGE, hasDatabase: false, strategies: [] };

export interface AppDeployWizardProps {
  clusters: Cluster[];
  deployments: Deployment[];
  onClose: () => void;
  onDeploy: (data: WizardData) => void;
  preset?: Partial<WizardData> | undefined;
}

const sizeUnread = (failure: unknown): string =>
  `Koala could not read this model's size from Hugging Face: ${errorMessage(failure)}. How much it downloads and how much GPU memory it needs are not known; check the model ID.`;

export default function AppDeployWizard({
  clusters, deployments, onClose, onDeploy, preset,
}: AppDeployWizardProps) {
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState<WizardData>({ ...EMPTY_WIZARD_DATA, ...preset });
  const [showVllmAdvanced, setShowVllmAdvanced] = useState(false);
  const [showTabbyAdvanced, setShowTabbyAdvanced] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');

  const targetCluster = clusters.find((c) => c.id === wizardData.clusterId);
  const vllmChoices = useMemo<GpuChoices>(() => (targetCluster ? gpuChoicesOf(targetCluster) : { vendors: [], problem: 'Pick the machine it runs on first.' }), [targetCluster]);
  const tabbyChoices = useMemo<GpuChoices>(() => (targetCluster ? gpuChoicesOf(targetCluster, { runsOn: ['nvidia'] }) : { vendors: [], problem: 'Pick the machine it runs on first.' }), [targetCluster]);
  const vllmGpus = chosenGpus(vllmChoices, { vendor: wizardData.vllmGpuVendor, count: wizardData.vllmGpuCount });
  const tabbyGpus = chosenGpus(tabbyChoices, { vendor: 'nvidia', count: wizardData.tabbyGpuCount });
  const chosen: WizardData = { ...wizardData, vllmGpuVendor: vllmGpus.vendor, vllmGpuCount: vllmGpus.count, tabbyGpuCount: tabbyGpus.count };
  const vllmToolCalling = useVllmToolCalling(wizardData.vllmModel, wizardData.vllmToolCallingEnabled && wizardData.appType === 'vllm', wizardData.vllmToolCallParser, wizardData.vllmHfToken);
  const debouncedTabbyModel = useDebounce(wizardData.tabbyModel);
  const debouncedTabbyRevision = useDebounce(wizardData.tabbyRevision);
  const debouncedTabbyMaxSeqLen = useDebounce(wizardData.tabbyMaxSeqLen);
  const debouncedVllmModel = useDebounce(wizardData.vllmModel);
  const debouncedVllmMaxModelLen = useDebounce(wizardData.vllmMaxModelLen);

  const {
    data: tabbyModelSize, isFetching: loadingTabbyModelSize, isError: tabbyModelSizeError, error: tabbyModelSizeFailure,
  } = useHfModelSize({
    repo: debouncedTabbyModel,
    revision: debouncedTabbyRevision,
    maxSeqLen: debouncedTabbyMaxSeqLen,
    cacheMode: wizardData.tabbyCacheMode,
    gpuCount: chosen.tabbyGpuCount,
  }, wizardStep === 4 && wizardData.appType === 'tabbyapi');

  const {
    data: vllmModelSize, isFetching: loadingVllmModelSize, isError: vllmModelSizeError, error: vllmModelSizeFailure,
  } = useHfModelSize({
    repo: debouncedVllmModel,
    maxSeqLen: debouncedVllmMaxModelLen,
    cacheMode: 'FP16',
    gpuCount: chosen.vllmGpuCount,
  }, wizardStep === 4 && wizardData.appType === 'vllm' && chosen.vllmGpuCount !== '');

  const {
    data: modelSearchResults = [], isFetching: loadingModelSearch,
  } = useModelSearch(wizardData.appType, modelSearchQuery, wizardStep === 3 && isModelApp(wizardData.appType));

  const { data: credentials = [] } = useQuery({
    queryKey: credentialKeys.list(),
    queryFn: listProviders,
  });
  const hasHfAccount = credentials.some((p) => p.provider === 'huggingface' && p.configured);

  const { data: catalogue = [] } = useAppCatalogue();
  const uiDefaultsFor = (appType: string): AppUiDefaults => catalogue.find((c) => c.id === appType)?.uiDefaults ?? EMPTY_UI_DEFAULTS;
  const catalogueOnlyEntries = catalogue.filter((c) => c.deploysFromSpec);
  // An app that deploys entirely from a stored spec — steps 2-5 would show fields that are
  // silently ignored if submitted, so those apps skip straight to confirm. A construct-backed app
  // (Odoo, WordPress, vLLM, ...) is also in the catalogue now, but still needs those steps.
  const isCatalogueApp = catalogue.some((c) => c.id === wizardData.appType && c.deploysFromSpec);
  const currentUiDefaults = uiDefaultsFor(wizardData.appType);
  const currentStrategies = currentUiDefaults.strategies ?? [];

  const { options: tabbyImageTagOptions, loading: loadingTabbyImageTags, unread: tabbyTagsUnread } = useTabbyImageTags(
    wizardStep === 4 && wizardData.appType === 'tabbyapi',
  );

  const { data: tabbyModelBranches = [], isFetching: loadingTabbyModelBranches } = useHfBranches(
    wizardData.tabbyModel,
    wizardStep === 3 && wizardData.appType === 'tabbyapi',
  );

  useEffect(() => {
    if (tabbyModelBranches.length > 0 && !wizardData.tabbyRevision) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see the note below
      setWizardData((prev) => ({ ...prev, tabbyRevision: tabbyModelBranches[0]! }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabbyModelBranches]);

  const handleAppTypeChange = (newAppType: string) => {
    const config = uiDefaultsFor(newAppType);
    const strategies = config.strategies ?? [];
    const newStrategy = strategies.includes(wizardData.strategy) ? wizardData.strategy : (strategies[0] ?? 'native');
    const defaults = config[newStrategy] ?? BLANK_IMAGE;
    const capitalized = newAppType.charAt(0).toUpperCase() + newAppType.slice(1);
    const gpuOnly = config.gpuOnly === true;

    setWizardData(prev => {
      const prevCapitalized = prev.appType.charAt(0).toUpperCase() + prev.appType.slice(1);
      const isDefaultName = prev.name === `${prevCapitalized}-Production`;
      const selectedCluster = clusters.find((c) => c.id === prev.clusterId);
      const stillValidCluster = !selectedCluster || !gpuOnly || reportsGpu(selectedCluster);
      let nextClusterId = stillValidCluster ? prev.clusterId : '';
      if (gpuOnly && !nextClusterId) {
        const gpuClusters = clusters.filter((c) => deployableTo(c) && reportsGpu(c));
        if (gpuClusters.length === 1) nextClusterId = gpuClusters[0]!.id;
      }
      return {
        ...prev,
        appType: newAppType,
        clusterId: nextClusterId,
        strategy: newStrategy,
        name: isDefaultName ? `${capitalized}-Production` : prev.name,
        odooRepo: defaults.webRepo,
        odooTag: defaults.webTag,
        pgRepo: defaults.dbRepo,
        pgTag: defaults.dbTag
      };
    });
  };

  const selectStrategy = (strat: 'helm' | 'native') => {
    const appType = wizardData.appType || 'odoo';
    const config = uiDefaultsFor(appType);
    if (!(config.strategies ?? []).includes(strat)) return;

    const defaults = config[strat] ?? BLANK_IMAGE;
    setWizardData(prev => ({
      ...prev,
      strategy: strat,
      odooRepo: defaults.webRepo,
      odooTag: defaults.webTag,
      pgRepo: defaults.dbRepo,
      pgTag: defaults.dbTag
    }));
  };

  const renderModelSearchPicker = (selectedModel: string, onSelect: (id: string) => void, placeholder = 'e.g. llama, mistral, qwen...') => (
    <div>
      <label htmlFor="wizard-search-hugging-face-models" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Search Hugging Face Models</label>
      <input id="wizard-search-hugging-face-models"
        value={modelSearchQuery}
        onChange={e => setModelSearchQuery(e.target.value)}
        className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm mb-2"
        placeholder={placeholder}
      />
      <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto custom-scrollbar pr-1">
        {loadingModelSearch ? (
          <div className="flex items-center gap-2 text-slate-500 text-xs py-3"><Loader2 size={14} className="animate-spin" /> Searching Hugging Face...</div>
        ) : modelSearchResults.length > 0 ? modelSearchResults.map((m) => (
          <button key={m.id} type="button" onClick={() => onSelect(m.id)} className={`px-4 py-3 rounded-lg text-left text-xs border transition-all ${selectedModel === m.id ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>
            <div className="font-bold">{m.id.split('/').pop()}</div>
            <div className="text-[10px] opacity-70">{m.id} · {m.downloads.toLocaleString()} downloads</div>
          </button>
        )) : (
          <div className="text-[10px] text-slate-600 italic text-center py-4">No matches — try a different search term.</div>
        )}
      </div>
    </div>
  );

  return (

    <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center mb-8">
          <h3 className="text-2xl font-bold">Deployment Wizard</h3>
          <div className="flex items-center gap-4">
            <div className="flex gap-2">
              {(isCatalogueApp ? [1, 6] : [1, 2, 3, 4, 5, 6]).map(s => {
                if (s === 3 && !isModelApp(wizardData.appType)) return null;
                if (s === 5 && !currentUiDefaults.hasDatabase) return null;
                return (
                  <div key={s} className={`w-8 h-1.5 rounded-full transition-all ${wizardStep >= s ? 'bg-blue-500' : 'bg-slate-700'}`}></div>
                );
              })}
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close Wizard">
              <X size={24} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
          {wizardStep === 1 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Package className="text-blue-500" size={18}/> Target Configuration</h4><p className="text-slate-400 text-sm">Select the infrastructure, name, and application type.</p></div>
              <div><label htmlFor="wizard-instance-name" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Instance Name</label><input id="wizard-instance-name" value={wizardData.name} onChange={e => setWizardData({...wizardData, name: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all" /></div>
              <div>
                <label htmlFor="wizard-target-cluster" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Target Cluster</label>
                <select id="wizard-target-cluster" value={wizardData.clusterId} onChange={e => setWizardData({...wizardData, clusterId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all">
                  <option value="">Select a cluster...</option>
                  {clusters.filter((c) => deployableTo(c) && (currentUiDefaults.gpuOnly !== true || reportsGpu(c))).map((c) => (
                    <option key={c.id} value={c.id}>{targetLabel(c)}</option>
                  ))}
                </select>
                {currentUiDefaults.gpuOnly === true && (
                  clusters.some((c) => deployableTo(c) && reportsGpu(c)) ? (
                    <p className="text-[11px] text-amber-400/80 mt-2">Only machines that report a GPU are shown — {wizardData.appType} needs one.</p>
                  ) : (
                    <div className="text-[11px] text-red-400/80 mt-2 space-y-1">
                      <p>None of your machines reports a GPU: a machine shows its GPUs here once its agent sees them, with nvidia-smi or the AMD kernel driver answering.</p>
                      {clusters.filter((c) => (c.gpuProblems ?? []).length > 0).map((c) => (
                        <p key={c.id}>{c.name}: {(c.gpuProblems ?? []).join('; ')}</p>
                      ))}
                    </div>
                  )
                )}
              </div>
              <div>
                <label htmlFor="wizard-app-type" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Application Type</label>
                <select
                  id="wizard-app-type"
                  value={wizardData.appType}
                  onChange={e => handleAppTypeChange(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100"
                >
                  <option value="odoo">Odoo ERP</option>
                  <option value="wordpress">WordPress CMS</option>
                  <option value="nextcloud">Nextcloud Cloud Storage</option>
                  <option value="audiobookshelf">Audiobookshelf Media Server</option>
                  <option value="prometheus">Prometheus Monitoring Stack</option>
                  <option value="traefik">Traefik Ingress Router</option>
                  <option value="vllm">vLLM LLM Server</option>
                  <option value="tabbyapi">TabbyAPI (EXL2/EXL3 LLM Server)</option>
                  <option value="openwebui">Open WebUI (LLM Chat UI)</option>
                  <option value="hermes">Hermes Agent (AI Agent & Dashboard)</option>
                  <option value="palworld">Palworld Dedicated Server</option>
                  <option value="jellyfin">Jellyfin Media Server</option>
                  <option value="plex">Plex Media Server</option>
                  <option value="navidrome">Navidrome Music Server</option>
                  <option value="kavita">Kavita Digital Library</option>
                  <option value="immich">Immich Photo & Video Backup</option>
                  <option value="papra">Papra Document Management</option>
                  <option value="searxng">SearXNG (agent web search)</option>
                  <option value="crawl4ai">Crawl4AI (agent page fetch)</option>
                  <option value="homeassistant">Home Assistant</option>
                  {catalogueOnlyEntries.length > 0 && (
                    <optgroup label="From the catalogue">
                      {catalogueOnlyEntries.map((c) => (
                        <option key={c.id} value={c.id}>{c.label ?? c.id}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            </div>
          )}
          {wizardStep === 2 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Blocks className="text-blue-400" size={18}/> Deployment Strategy</h4><p className="text-slate-400 text-sm">Choose how the application is orchestrated.</p></div>
              <div className="grid grid-cols-2 gap-4">
                <button
                  disabled={!currentStrategies.includes('helm')}
                  onClick={() => selectStrategy('helm')}
                  className={`p-6 rounded-2xl border-2 text-left transition-all relative ${!currentStrategies.includes('helm') ? 'opacity-40 cursor-not-allowed border-slate-800 bg-slate-900' : wizardData.strategy === 'helm' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`}
                >
                  <div className="p-3 bg-blue-500/20 rounded-xl w-fit mb-4"><Layers size={24} className="text-blue-500" /></div>
                  <div className="font-bold text-lg">Helm Chart</div>
                  <div className="text-xs text-slate-400 mt-1">Bitnami-managed stack. Includes advanced features and hardened images.</div>
                  {!currentStrategies.includes('helm') && (
                    <span className="absolute top-4 right-4 text-[9px] font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 uppercase">Not Supported</span>
                  )}
                </button>
                <button
                  disabled={!currentStrategies.includes('native')}
                  onClick={() => selectStrategy('native')}
                  className={`p-6 rounded-2xl border-2 text-left transition-all relative ${!currentStrategies.includes('native') ? 'opacity-40 cursor-not-allowed border-slate-800 bg-slate-900' : wizardData.strategy === 'native' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`}
                >
                  <div className="p-3 bg-green-500/20 rounded-xl w-fit mb-4"><Box size={24} className="text-green-500" /></div>
                  <div className="font-bold text-lg">Native K8s</div>
                  <div className="text-xs text-slate-400 mt-1">Raw Kubernetes resources. Uses official library images directly.</div>
                  {!currentStrategies.includes('native') && (
                    <span className="absolute top-4 right-4 text-[9px] font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 uppercase">Not Supported</span>
                  )}
                </button>
              </div>
            </div>
          )}
          {wizardStep === 3 && isModelApp(wizardData.appType) && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                <h4 className="font-bold flex items-center gap-2 mb-2"><Zap className="text-yellow-500" size={18}/> Find a Model</h4>
                <p className="text-slate-400 text-sm">
                  {wizardData.appType === 'tabbyapi'
                    ? "TabbyAPI's exllamav3 backend only runs EXL3 quants, so this is turboderp's curated EXL3 model collection — the closest thing to an authoritative \"this will actually load\" list."
                    : "Search Hugging Face for a model to serve — you'll fine-tune the configuration on the next step."}
                </p>
              </div>
              {renderModelSearchPicker(
                wizardData.appType === 'tabbyapi' ? wizardData.tabbyModel : wizardData.vllmModel,
                (id) => setWizardData(wizardData.appType === 'tabbyapi' ? {...wizardData, tabbyModel: id, tabbyRevision: ''} : {...wizardData, vllmModel: id}),
                wizardData.appType === 'tabbyapi' ? 'e.g. qwen, llama, gemma... (filters the exl3 collection)' : undefined,
              )}
              {(wizardData.appType === 'tabbyapi' ? wizardData.tabbyModel : wizardData.vllmModel) && (
                <div className="p-4 bg-blue-500/5 border border-blue-500/20 rounded-xl text-xs text-blue-300 flex items-center gap-2">
                  <Check size={14} /> Selected: <span className="font-mono">{wizardData.appType === 'tabbyapi' ? wizardData.tabbyModel : wizardData.vllmModel}</span>
                </div>
              )}
              {wizardData.appType === 'tabbyapi' && wizardData.tabbyModel && (
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Bits Per Weight (Quantization)</label>
                  {loadingTabbyModelBranches ? (
                    <div className="flex items-center gap-2 text-slate-500 text-xs py-3"><Loader2 size={14} className="animate-spin" /> Checking available bpw branches...</div>
                  ) : tabbyModelBranches.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2">
                      {tabbyModelBranches.map((b: string) => (
                        <button key={b} type="button" onClick={() => setWizardData({...wizardData, tabbyRevision: b})} className={`px-3 py-2.5 rounded-lg text-xs font-mono border transition-all ${wizardData.tabbyRevision === b ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>
                          {b}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 italic">No branches found — this repo may only have a single default version.</p>
                  )}
                  <p className="text-[11px] text-slate-500 mt-2">Higher bpw = better quality, more VRAM. Lower bpw = smaller, faster, more quality loss. Sets the Revision field on the next step — still editable there.</p>
                </div>
              )}
            </div>
          )}
          {wizardStep === 4 && wizardData.appType === 'vllm' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Zap className="text-yellow-500" size={18}/> LLM Model Selection</h4><p className="text-slate-400 text-sm">Fine-tune the configuration for the model you selected.</p></div>
              <div><label htmlFor="wizard-huggingface-model-id" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Model ID</label><input id="wizard-huggingface-model-id" value={wizardData.vllmModel} onChange={e => setWizardData({...wizardData, vllmModel: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" placeholder="e.g. meta-llama/Llama-3.2-3B-Instruct" /></div>
              <div><label htmlFor="wizard-gpu-count" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Count</label><select id="wizard-gpu-count" value={chosen.vllmGpuCount} onChange={e => setWizardData({...wizardData, vllmGpuCount: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">{(vllmChoices.vendors.find((choice) => choice.vendor === chosen.vllmGpuVendor)?.counts ?? []).map((count) => <option key={count} value={count}>{count} GPU{count === '1' ? '' : 's'}</option>)}</select>
                {vllmChoices.problem && <p className="text-[11px] text-amber-400/90 mt-2">{vllmChoices.problem}</p>}
                {loadingVllmModelSize && (
                  <p className="text-[11px] text-slate-500 mt-2 flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> Checking model size on Hugging Face...</p>
                )}
                {!loadingVllmModelSize && vllmModelSize?.totalBytes && (
                  <div className="text-[11px] text-blue-400 mt-2 space-y-1">
                    <p>~{(vllmModelSize.totalBytes / 1e9).toFixed(1)} GB download ({vllmModelSize.fileCount} files)</p>
                    {vllmModelSize.weightBytesPerGpu !== undefined && vllmModelSize.kvCacheBytesPerGpu !== undefined && chosen.vllmGpuCount !== '0' && (
                      <p className={vllmModelSize.weightBytesPerGpu + vllmModelSize.kvCacheBytesPerGpu > 20e9 ? 'text-amber-400/90' : ''}>
                        Est. VRAM per GPU at {parseInt(wizardData.vllmMaxModelLen || '0').toLocaleString() || 'default'} tokens: ~{((vllmModelSize.weightBytesPerGpu + vllmModelSize.kvCacheBytesPerGpu) / 1e9).toFixed(1)} GB
                        {' '}(weights ~{(vllmModelSize.weightBytesPerGpu / 1e9).toFixed(1)}GB + KV cache ~{(vllmModelSize.kvCacheBytesPerGpu / 1e9).toFixed(1)}GB, fp16 assumed) — rough estimate, check this fits your GPU's VRAM.
                      </p>
                    )}
                  </div>
                )}
                {!loadingVllmModelSize && vllmModelSizeError && (
                  <p className="text-[11px] text-amber-400/90 mt-2" role="alert">{sizeUnread(vllmModelSizeFailure)}</p>
                )}
              </div>
              {vllmChoices.vendors.length > 0 && <div><label htmlFor="wizard-gpu-vendor" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Vendor</label><select id="wizard-gpu-vendor" value={chosen.vllmGpuVendor} onChange={e => setWizardData({...wizardData, vllmGpuVendor: e.target.value as GpuVendor})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">{vllmChoices.vendors.map((choice) => <option key={choice.vendor} value={choice.vendor}>{choice.label}</option>)}</select></div>}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label htmlFor="wizard-hugging-face-access-token-hf-token" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Hugging Face Access Token (HF_TOKEN)</label>
                  {hasHfAccount && (
                    <span className="text-[10px] font-bold text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded flex items-center gap-1">
                      ✓ Account Token Saved
                    </span>
                  )}
                </div>
                <input id="wizard-hugging-face-access-token-hf-token" type="password" value={wizardData.vllmHfToken} onChange={e => setWizardData({...wizardData, vllmHfToken: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={hasHfAccount ? "Auto-using saved account token (or enter custom token)" : "e.g. hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"} />
                <p className="text-[11px] text-slate-500 mt-1">
                  {hasHfAccount
                    ? "Saved token from Cloud Accounts will automatically be used if left blank. Enter a value above only to override."
                    : "Required for gated models (e.g. Llama 3.2, Gemma 2). Get a Read token at huggingface.co/settings/tokens or save it in Cloud Accounts."}
                </p>
              </div>
              <VllmToolCalling idPrefix="wizard" calling={vllmToolCalling} enabled={wizardData.vllmToolCallingEnabled} picked={wizardData.vllmToolCallParser} onChange={({ enabled, picked }) => setWizardData({ ...wizardData, vllmToolCallingEnabled: enabled, vllmToolCallParser: picked })} />
              <div className="pt-2 border-t border-slate-800">
                <button type="button" onClick={() => setShowVllmAdvanced(!showVllmAdvanced)} className="flex items-center gap-2 text-[11px] font-black text-slate-400 uppercase tracking-widest hover:text-slate-200 transition-colors">
                  {showVllmAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Advanced vLLM Arguments
                </button>
                {showVllmAdvanced && (
                  <div className="mt-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div>
                      <label htmlFor="wizard-max-model-length-max-model-len" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Model Length (--max-model-len)</label>
                      <input id="wizard-max-model-length-max-model-len" type="number" value={wizardData.vllmMaxModelLen} onChange={e => setWizardData({...wizardData, vllmMaxModelLen: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 32768 (leave blank for model default)" />
                      <p className="text-[11px] text-slate-500 mt-1">Lower this if you see a KV-cache-too-small error at startup.</p>
                    </div>
                    <div>
                      <label htmlFor="wizard-gpu-memory-utilization-gpu-memory-utilization" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Memory Utilization (--gpu-memory-utilization)</label>
                      <input id="wizard-gpu-memory-utilization-gpu-memory-utilization" type="number" step="0.05" min="0" max="1" value={wizardData.vllmGpuMemUtil} onChange={e => setWizardData({...wizardData, vllmGpuMemUtil: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 0.9 (leave blank for vLLM default)" />
                      <p className="text-[11px] text-slate-500 mt-1">Fraction of GPU VRAM vLLM is allowed to reserve for weights + KV cache.</p>
                    </div>
                    <div>
                      <label htmlFor="wizard-served-model-name" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Served Model Name</label>
                      <input id="wizard-served-model-name" value={wizardData.vllmServedModelName} onChange={e => setWizardData({...wizardData, vllmServedModelName: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="Alias exposed via the API — defaults to the model ID" />
                    </div>
                    <div>
                      <label htmlFor="wizard-max-concurrent-sequences-max-num-seqs" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Concurrent Sequences (--max-num-seqs)</label>
                      <input id="wizard-max-concurrent-sequences-max-num-seqs" type="number" value={wizardData.vllmMaxNumSeqs} onChange={e => setWizardData({...wizardData, vllmMaxNumSeqs: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 256 (leave blank for vLLM default)" />
                    </div>
                    <div>
                      <label htmlFor="wizard-data-type-dtype" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Data Type (--dtype)</label>
                      <select id="wizard-data-type-dtype" value={wizardData.vllmDtype} onChange={e => setWizardData({...wizardData, vllmDtype: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                        <option value="">Auto (model default)</option>
                        <option value="half">half / float16</option>
                        <option value="bfloat16">bfloat16</option>
                        <option value="float32">float32</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" id="wiz-prefix-caching" checked={wizardData.vllmEnablePrefixCaching} onChange={e => setWizardData({...wizardData, vllmEnablePrefixCaching: e.target.checked})} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                      <label htmlFor="wiz-prefix-caching" className="text-sm text-slate-300 cursor-pointer select-none">Enable Prefix Caching</label>
                    </div>
                    <div>
                      <label htmlFor="wizard-additional-arguments" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Additional Arguments</label>
                      <textarea id="wizard-additional-arguments" value={wizardData.vllmExtraArgs} onChange={e => setWizardData({...wizardData, vllmExtraArgs: e.target.value})} rows={3} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="Any other vllm serve flags" />
                      <p className="text-[11px] text-slate-500 mt-1">Free-form flags appended to the `vllm serve` command as-is.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {wizardStep === 4 && wizardData.appType === 'tabbyapi' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Zap className="text-yellow-500" size={18}/> LLM Model Selection</h4><p className="text-slate-400 text-sm">Fine-tune the configuration for the model you selected.</p></div>
              <div><label htmlFor="wizard-huggingface-model-id-2" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Model ID</label><input id="wizard-huggingface-model-id-2" value={wizardData.tabbyModel} onChange={e => setWizardData({...wizardData, tabbyModel: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" placeholder="e.g. bartowski/Llama-3.2-3B-Instruct-exl2" /></div>
              <div>
                <label htmlFor="wizard-revision-branch-optional" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Revision / Branch (optional)</label>
                <input id="wizard-revision-branch-optional" value={wizardData.tabbyRevision} onChange={e => setWizardData({...wizardData, tabbyRevision: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 6.0bpw — EXL2/EXL3 quants are usually split across repo branches" />
                {loadingTabbyModelSize && (
                  <p className="text-[11px] text-slate-500 mt-2 flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> Checking model size on Hugging Face...</p>
                )}
                {!loadingTabbyModelSize && tabbyModelSize?.totalBytes && (
                  <div className="text-[11px] text-blue-400 mt-2 space-y-1">
                    <p>~{(tabbyModelSize.totalBytes / 1e9).toFixed(1)} GB download ({tabbyModelSize.fileCount} files) — used to size GPU shared memory automatically at deploy time.</p>
                    {tabbyModelSize.weightBytesPerGpu !== undefined && tabbyModelSize.kvCacheBytesPerGpu !== undefined && (
                      <p className={tabbyModelSize.weightBytesPerGpu + tabbyModelSize.kvCacheBytesPerGpu > 20e9 ? 'text-amber-400/90' : ''}>
                        Est. VRAM per GPU at {parseInt(wizardData.tabbyMaxSeqLen || '0').toLocaleString()} tokens: ~{((tabbyModelSize.weightBytesPerGpu + tabbyModelSize.kvCacheBytesPerGpu) / 1e9).toFixed(1)} GB
                        {' '}(weights ~{(tabbyModelSize.weightBytesPerGpu / 1e9).toFixed(1)}GB + KV cache ~{(tabbyModelSize.kvCacheBytesPerGpu / 1e9).toFixed(1)}GB) — check this fits your GPU's VRAM, plus headroom for activations.
                      </p>
                    )}
                  </div>
                )}
                {!loadingTabbyModelSize && tabbyModelSizeError && (
                  <p className="text-[11px] text-amber-400/90 mt-2" role="alert">{sizeUnread(tabbyModelSizeFailure)}</p>
                )}
              </div>
              <div><label htmlFor="wizard-gpu-count-2" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Count</label><select id="wizard-gpu-count-2" value={chosen.tabbyGpuCount} onChange={e => setWizardData({...wizardData, tabbyGpuCount: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">{(tabbyChoices.vendors[0]?.counts ?? []).map((count) => <option key={count} value={count}>{count} GPU{count === '1' ? '' : 's'}</option>)}</select>
                {tabbyChoices.problem && <p className="text-[11px] text-amber-400/90 mt-2">{tabbyChoices.problem}</p>}
                <p className="text-[11px] text-slate-500 mt-1">TabbyAPI's exllamav3 backend is NVIDIA CUDA-only — there's no CPU or ROCm mode.</p>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label htmlFor="wizard-hugging-face-access-token-hf-token-2" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Hugging Face Access Token (HF_TOKEN)</label>
                  {hasHfAccount && (
                    <span className="text-[10px] font-bold text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded flex items-center gap-1">
                      ✓ Account Token Saved
                    </span>
                  )}
                </div>
                <input id="wizard-hugging-face-access-token-hf-token-2" type="password" value={wizardData.tabbyHfToken} onChange={e => setWizardData({...wizardData, tabbyHfToken: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={hasHfAccount ? "Auto-using saved account token (or enter custom token)" : "e.g. hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"} />
                <p className="text-[11px] text-slate-500 mt-1">
                  {hasHfAccount
                    ? "Saved token from Cloud Accounts will automatically be used if left blank. Enter a value above only to override."
                    : "Required for gated models or private repos. Get a Read token at huggingface.co/settings/tokens or save it in Cloud Accounts."}
                </p>
              </div>
              <div className="pt-2 border-t border-slate-800">
                <button type="button" onClick={() => setShowTabbyAdvanced(!showTabbyAdvanced)} className="flex items-center gap-2 text-[11px] font-black text-slate-400 uppercase tracking-widest hover:text-slate-200 transition-colors">
                  {showTabbyAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Advanced TabbyAPI Arguments
                </button>
                {showTabbyAdvanced && (
                  <div className="mt-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div>
                      <label htmlFor="wizard-cache-mode" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cache Mode</label>
                      <select id="wizard-cache-mode" value={wizardData.tabbyCacheMode} onChange={e => setWizardData({...wizardData, tabbyCacheMode: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                        <option value="">FP16 (default)</option>
                        <option value="Q8">Q8 — saves VRAM, minor quality loss</option>
                        <option value="Q6">Q6</option>
                        <option value="Q4">Q4 — most VRAM savings</option>
                      </select>
                      <p className="text-[11px] text-slate-500 mt-1">Quantizes the KV cache. Lower it if you're VRAM-constrained.</p>
                    </div>
                    <div>
                      <label htmlFor="wizard-max-sequence-length" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Sequence Length</label>
                      <input id="wizard-max-sequence-length" type="number" value={wizardData.tabbyMaxSeqLen} onChange={e => setWizardData({...wizardData, tabbyMaxSeqLen: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 32768 (leave blank for model default)" />
                    </div>
                    <div>
                      <label htmlFor="wizard-max-concurrent-generations" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Concurrent Generations</label>
                      <input id="wizard-max-concurrent-generations" type="number" value={wizardData.tabbyMaxBatchSize} onChange={e => setWizardData({...wizardData, tabbyMaxBatchSize: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 8 (leave blank for TabbyAPI default)" />
                    </div>
                    <div>
                      <label htmlFor="wizard-image-variant" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Image Variant</label>
                      {tabbyTagsUnread ? (
                        <TypedTag why={tabbyTagsUnread} value={wizardData.tabbyImageTag} onChange={tabbyImageTag => setWizardData({...wizardData, tabbyImageTag})} />
                      ) : (
                        <select id="wizard-image-variant" value={wizardData.tabbyImageTag} onChange={e => setWizardData({...wizardData, tabbyImageTag: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                          {!tabbyImageTagOptions.some((opt) => opt.tag === wizardData.tabbyImageTag) && <option value={wizardData.tabbyImageTag}>{loadingTabbyImageTags ? 'Checking available images...' : wizardData.tabbyImageTag}</option>}
                          {tabbyImageTagOptions.map(opt => (
                            <option key={opt.tag} value={opt.tag}>{opt.label}{opt.cached ? ' ✓ cached locally' : ''}</option>
                          ))}
                        </select>
                      )}
                      {loadingTabbyImageTags && <p className="text-[11px] text-slate-500 mt-1">Fetching available tags from ghcr.io...</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" id="wiz-tabby-reasoning" checked={wizardData.tabbyReasoning} onChange={e => setWizardData({...wizardData, tabbyReasoning: e.target.checked})} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                      <label htmlFor="wiz-tabby-reasoning" className="text-sm text-slate-300 cursor-pointer select-none">Reasoning Model</label>
                      <span className="text-[10px] text-slate-500 ml-auto">Enable for thinking models (e.g. DeepSeek-R1 style)</span>
                    </div>
                    <div>
                      <label htmlFor="wizard-tool-call-format" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Tool Call Format</label>
                      <select id="wizard-tool-call-format" value={wizardData.tabbyToolFormat} onChange={e => setWizardData({...wizardData, tabbyToolFormat: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                        <option value="">None — tool calls won't be parsed</option>
                        {(currentUiDefaults.toolFormats ?? []).map(fmt => <option key={fmt} value={fmt}>{fmt}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" id="wiz-tabby-inline" checked={wizardData.tabbyInlineModelLoading} onChange={e => setWizardData({...wizardData, tabbyInlineModelLoading: e.target.checked})} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                      <label htmlFor="wiz-tabby-inline" className="text-sm text-slate-300 cursor-pointer select-none">Allow Inline Model Loading</label>
                    </div>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" id="wiz-tabby-auth" checked={!wizardData.tabbyDisableAuth} onChange={e => setWizardData({...wizardData, tabbyDisableAuth: !e.target.checked})} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                      <label htmlFor="wiz-tabby-auth" className="text-sm text-slate-300 cursor-pointer select-none">Require API Key</label>
                      <span className="text-[10px] text-slate-500 ml-auto">Off by default so Open WebUI can connect with no key configured</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label htmlFor="wizard-memory-limit-ram" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Memory Limit (RAM)</label>
                        <input id="wizard-memory-limit-ram" value={wizardData.tabbyMemoryLimit} onChange={e => setWizardData({...wizardData, tabbyMemoryLimit: e.target.value})} placeholder="32G (default)" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm" />
                      </div>
                      <div>
                        <label htmlFor="wizard-shared-memory-dev-shm" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Shared Memory (/dev/shm)</label>
                        <input id="wizard-shared-memory-dev-shm" value={wizardData.tabbyShmSize} onChange={e => setWizardData({...wizardData, tabbyShmSize: e.target.value})} placeholder="16Gi (default)" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm" />
                      </div>
                      <div>
                        <label htmlFor="wizard-cpu-limit" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">CPU Limit</label>
                        <input id="wizard-cpu-limit" value={wizardData.tabbyCpuLimit} onChange={e => setWizardData({...wizardData, tabbyCpuLimit: e.target.value})} placeholder="10 (default)" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm" />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="wizard-additional-config-env-overrides" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Additional Config (env overrides)</label>
                      <textarea id="wizard-additional-config-env-overrides" value={wizardData.tabbyExtraEnv} onChange={e => setWizardData({...wizardData, tabbyExtraEnv: e.target.value})} rows={3} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={"One per line, e.g.\nTABBY_MODEL_CHUNK_SIZE=4096\nTABBY_MODEL_ROPE_SCALE=1.0"} />
                      <p className="text-[11px] text-slate-500 mt-1">Any other scalar config.yml field as a TABBY_&lt;SECTION&gt;_&lt;FIELD&gt; env override (text/number/true-false only — TabbyAPI can't set list-type fields like dummy_model_names via env vars).</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {wizardStep === 4 && wizardData.appType !== 'vllm' && wizardData.appType !== 'tabbyapi' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Zap className="text-yellow-500" size={18}/> Component: {wizardData.appType.charAt(0).toUpperCase() + wizardData.appType.slice(1)}</h4><p className="text-slate-400 text-sm">Select the image version.</p></div>
              <div><label htmlFor="wizard-docker-repository" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label><input id="wizard-docker-repository" value={wizardData.odooRepo} onChange={e => setWizardData({...wizardData, odooRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" /></div>
              <TagPicker
                repo={wizardData.odooRepo}
                selected={wizardData.odooTag}
                onSelect={(tag) => setWizardData({ ...wizardData, odooTag: tag })}
                enabled={wizardStep === 4}
              />
              {wizardData.appType === 'openwebui' && (
                <div>
                  <label htmlFor="wizard-llm-backend-vllm-tabbyapi-deployment" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">LLM Backend (vLLM / TabbyAPI Deployment)</label>
                  <select id="wizard-llm-backend-vllm-tabbyapi-deployment" value={wizardData.openWebuiTargetId} onChange={e => setWizardData({...wizardData, openWebuiTargetId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                    <option value="">No backend (configure manually later)</option>
                    {deployments.filter((d) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.vllmModel || d.tabbyModel || (d.appType === 'tabbyapi' ? 'TabbyAPI' : 'vLLM')})</option>
                    ))}
                  </select>
                  {deployments.filter((d) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).length === 0 ? (
                    deployments.some((d) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running') ? (
                      <p className="text-[11px] text-amber-400/80 mt-2">Your running vLLM/TabbyAPI deployment(s) are on a different cluster than this app's Target Cluster (step 1) — go back and pick the same cluster, since Open WebUI reaches them over the cluster's internal network. Only same-cluster backends are listed.</p>
                    ) : (
                      <p className="text-[11px] text-amber-400/80 mt-2">No running vLLM/TabbyAPI deployments found. Deploy one first, or connect this later by editing the deployment's environment.</p>
                    )
                  ) : (
                    <p className="text-[11px] text-slate-500 mt-1">Open WebUI reaches its backend over the cluster's internal network — only deployments on the same Target Cluster (step 1) are listed.</p>
                  )}
                </div>
              )}
              {wizardData.appType === 'hermes' && (
                <div>
                  <label htmlFor="wizard-llm-backend-vllm-tabbyapi-deployment-2" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">LLM Backend (vLLM / TabbyAPI Deployment)</label>
                  <select id="wizard-llm-backend-vllm-tabbyapi-deployment-2" value={wizardData.hermesTargetId} onChange={e => setWizardData({...wizardData, hermesTargetId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                    <option value="">No backend (configure manually later)</option>
                    {deployments.filter((d) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.vllmModel || d.tabbyModel || (d.appType === 'tabbyapi' ? 'TabbyAPI' : 'vLLM')})</option>
                    ))}
                  </select>
                  {deployments.filter((d) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).length === 0 ? (
                    deployments.some((d) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running') ? (
                      <p className="text-[11px] text-amber-400/80 mt-2">Your running vLLM/TabbyAPI deployment(s) are on a different cluster than this app's Target Cluster (step 1) — go back and pick the same cluster. Only same-cluster backends are listed.</p>
                    ) : (
                      <p className="text-[11px] text-amber-400/80 mt-2">No running vLLM/TabbyAPI deployments found. Deploy one first, or connect this later.</p>
                    )
                  ) : (
                    <p className="text-[11px] text-slate-500 mt-1">Hermes Agent reaches its backend over the cluster's internal network — only deployments on the same Target Cluster (step 1) are listed.</p>
                  )}
                </div>
              )}
              {wizardData.appType === 'openwebui' && (
                <div className="space-y-4 pt-2 border-t border-slate-800">
                  <div className="flex items-center justify-between p-4 bg-slate-900/60 border border-slate-700 rounded-2xl">
                    <div>
                      <div className="font-bold text-sm text-slate-200">Web Search</div>
                      <div className="text-xs text-slate-400 mt-0.5">Lets the model look things up during chat — off by default it has no internet access at all.</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setWizardData({...wizardData, webuiEnableWebSearch: !wizardData.webuiEnableWebSearch})}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${wizardData.webuiEnableWebSearch ? 'bg-blue-600' : 'bg-slate-700'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${wizardData.webuiEnableWebSearch ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  {wizardData.webuiEnableWebSearch && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                      <div>
                        <label htmlFor="wizard-search-engine" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Search Engine</label>
                        <select id="wizard-search-engine" value={wizardData.webuiWebSearchEngine} onChange={e => setWizardData({...wizardData, webuiWebSearchEngine: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                          <option value="duckduckgo">DuckDuckGo — no API key needed</option>
                          <option value="tavily">Tavily</option>
                          <option value="brave">Brave Search</option>
                          <option value="serper">Serper</option>
                          <option value="bing">Bing</option>
                        </select>
                      </div>
                      {wizardData.webuiWebSearchEngine !== 'duckduckgo' && (
                        <div>
                          <label htmlFor="wizard-api-key" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">API Key</label>
                          <input id="wizard-api-key" type="password" value={wizardData.webuiWebSearchApiKey} onChange={e => setWizardData({...wizardData, webuiWebSearchApiKey: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={`API key for ${wizardData.webuiWebSearchEngine}`} />
                        </div>
                      )}
                      <p className="text-[11px] text-slate-500">Still needs to be toggled on per-conversation in Open WebUI's chat box — this just makes the feature available.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {wizardStep === 5 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Database className="text-green-500" size={18}/> Component: Database</h4><p className="text-slate-400 text-sm">Select the database version.</p></div>
              <div><label htmlFor="wizard-docker-repository-2" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label><input id="wizard-docker-repository-2" value={wizardData.pgRepo} onChange={e => setWizardData({...wizardData, pgRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" /></div>
              <TagPicker
                repo={wizardData.pgRepo}
                selected={wizardData.pgTag}
                onSelect={(tag) => setWizardData({ ...wizardData, pgTag: tag })}
                enabled={wizardStep === 5}
              />
            </div>
          )}
          {wizardStep === 6 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-8 bg-green-500/5 rounded-3xl border border-green-500/20 text-center"><div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4"><Check className="text-green-500" size={32} /></div><h4 className="text-xl font-bold">Ready to Launch</h4><p className="text-slate-400 text-sm">Confirm the configuration for <strong>{wizardData.name}</strong>.</p></div>
              <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-700 space-y-4 text-sm">
                <div className="flex justify-between border-b border-slate-800 pb-3"><span>Cluster</span><span className="font-bold text-slate-300">{clusters.find((c) => c.id === wizardData.clusterId)?.name}</span></div>
                {isCatalogueApp ? (
                  <div className="flex justify-between"><span>App</span><span className="font-mono text-xs text-slate-300">{catalogue.find((c) => c.id === wizardData.appType)?.label ?? wizardData.appType}</span></div>
                ) : (
                  <>
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>Strategy</span><span className="font-bold text-blue-400 uppercase tracking-widest text-[10px]">{wizardData.strategy}</span></div>
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>{wizardData.appType.charAt(0).toUpperCase() + wizardData.appType.slice(1)}</span><span className="font-mono text-xs text-slate-300">{wizardData.appType === 'tabbyapi' ? `${wizardData.tabbyModel}${wizardData.tabbyRevision ? '@' + wizardData.tabbyRevision : ''} (${chosen.tabbyGpuCount} GPU)` : wizardData.appType === 'vllm' ? `${wizardData.vllmModel} (${chosen.vllmGpuCount === '0' ? 'CPU only' : `${chosen.vllmGpuCount} GPU`})` : `${wizardData.odooRepo}:${wizardData.odooTag}`}</span></div>
                    {currentUiDefaults.hasDatabase && (
                      <div className="flex justify-between"><span>Database</span><span className="font-mono text-xs text-slate-300">{wizardData.pgRepo}:{wizardData.pgTag}</span></div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="mt-10 flex gap-4 pt-8 border-t border-slate-700">{wizardStep > 1 && (<button onClick={() => setWizardStep((n) => prevStep(n, wizardData.appType, isCatalogueApp, catalogue))} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2"><ArrowLeft size={18} /> Back</button>)}<div className="flex-1"></div>{wizardStep < 6 ? (<button disabled={(wizardStep === 1 && !wizardData.clusterId) || (wizardStep === 4 && ((wizardData.appType === 'vllm' && (chosen.vllmGpuCount === '' || toolCallingBlocks(vllmToolCalling))) || (wizardData.appType === 'tabbyapi' && chosen.tabbyGpuCount === '')))} onClick={() => setWizardStep((n) => nextStep(n, wizardData.appType, isCatalogueApp, catalogue))} className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 disabled:opacity-50">Next <ArrowRight size={18} /></button>) : (<button onClick={() => onDeploy(deployPayloadOf(chosen) as WizardData)} className="px-10 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold">🚀 Initiate Deployment</button>)}</div>
      </div>
    </div>
  );
}
