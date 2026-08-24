import { useState, useRef, useEffect } from 'react';
import { Activity, AlertTriangle, Box, Check, Cpu, Database, ExternalLink, FileText, HardDrive, Layers, Loader2, Puzzle, RefreshCw, Server, Settings, Shield, Terminal, Trash2, X, Zap } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, API_BASE } from '../../api/client';
import {
  useDeploymentPods, useHelmStatus, useDiagnostics,
  useAvailableModules, useResourcePlan, useInitialLogs, deploymentKeys,
} from '../../api/deployments';
import { useTabbyImageTags } from '../../api/models';
import { useLogSocket } from '../../stores/socket';
import { useShellStore } from '../../stores/shell';
import type { Deployment } from '../../types/deployment';
import type { Cluster } from '../../types/cluster';
import { AnsiText } from '../AnsiText';
import GameServerSettings from '../GameServerSettings';
import { APP_DEFAULTS, TABBY_TOOL_FORMATS } from '../app-catalog';
import { NO_WEB_UI_APP_TYPES } from '../../lib/app-ui';
import { getSupportedVolumes, getFallbackSize, getVolumeDescription } from '../../lib/app-volumes';

/**
 * The log and dashboard modal: seven tabs over one deployment or cluster.
 *
 * ── THE LARGEST BLOCK IN App.tsx ──
 * 765 lines of the 2,858 — provisioning logs, live pod tails, Helm status, diagnostics, git
 * modules, storage resizing, and the config panel. It carried nine pieces of state and seven
 * react-query calls that App ran on its behalf, each gated on an inline
 * `!!showLogModal && logTab === 'x'` condition.
 *
 * It owns all of that now. The `enabled` conditions are what keep a seven-tab modal from making
 * seven requests every time it opens: each tab fetches only while it is the tab you are looking at.
 */

export type LogTab = 'general' | 'provision' | 'helm' | 'app' | 'diagnostics' | 'modules' | 'storage';

export interface AppDashboardProps {
  /** Which resource is open. The modal is not rendered when this is null. */
  target: { type: 'cluster' | 'app'; id: string };
  deployment: Deployment | null;
  /** Every deployment, for the config panel's "point this at another app" pickers. */
  deployments: Deployment[];
  /** Every cluster, so the header can name the one this is running on. */
  clusters: Cluster[];
  cluster: Cluster | null;
  onClose: () => void;
  /** Which tab to open on. App picks `provision` for a cluster, `general` for an app. */
  initialTab?: LogTab;
}

export default function AppDashboard({
  target, deployment: currentDeployment, deployments, clusters, cluster: currentCluster, onClose,
  initialTab = 'general',
}: AppDashboardProps) {
  const qc = useQueryClient();
  const queryClient = qc;
  /** Scrolls the log pane to the newest line. */
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const showLogModal = target;

  const [logTab, setLogTab] = useState<LogTab>(initialTab);
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [socketLogs, setSocketLogs] = useState('');
  const [kubeLogs, setKubeLogs] = useState('');
  const [lastLogAt, setLastLogAt] = useState<number | null>(null);
  const [storageInputs, setStorageInputs] = useState<Record<string, string>>({});
  const [exposurePathInput, setExposurePathInput] = useState('');

  const setConfirmDestroy = useShellStore((s) => s.setConfirmDestroy);

  const isApp = showLogModal.type === 'app';

  const { pods, namespace, checkedAt: podsCheckedAt } = useDeploymentPods(
    showLogModal.id, isApp && logTab === 'app',
  );
  const { data: helmStatus } = useHelmStatus(showLogModal.id, isApp && logTab === 'helm');
  const { data: diagnostics } = useDiagnostics(showLogModal.id, isApp && logTab === 'diagnostics');
  const { data: availableModules = [], isLoading: loadingModules } = useAvailableModules(
    currentDeployment?.appType, logTab === 'modules' && !!currentDeployment,
  );
  const { data: resourcePlan } = useResourcePlan(currentDeployment);
  const { options: tabbyImageTagOptions, loading: loadingTabbyImageTags } = useTabbyImageTags(
    currentDeployment?.appType === 'tabbyapi',
  );

  /**
   * The log file on disk, fetched once. Also fetched for a FAILED app on the general tab — that is
   * where the reason lives, and the user has no reason to know it is filed under "provision".
   */
  const { data: initialLogs } = useInitialLogs(
    showLogModal,
    logTab === 'provision'
      || (isApp && currentDeployment?.status === 'failed' && logTab === 'general'),
  );

  /**
   * The resource's provisioning log, on its own connection joined to exactly one room.
   *
   * Cleared on join AND on reconnect: the server replays recent history rather than resuming, so a
   * replay landing on top of what is already accumulated shows as the identical lines repeating.
   */
  useLogSocket({
    room: showLogModal.id,
    onChunk: (chunk) => setSocketLogs((prev) => prev + chunk),
    onReconnect: () => setSocketLogs(''),
  });

  /**
   * The selected pod's live tail, on its own connection for the same reason.
   *
   * The server always restarts the tail from scratch (`kubectl logs --tail=100`) rather than
   * resuming, so the buffer is cleared on every rejoin or the re-fetched history duplicates what is
   * already on screen.
   */
  const tailing = isApp && logTab === 'app' && selectedPod;
  useLogSocket({
    room: tailing ? showLogModal.id : null,
    event: 'kube-log',
    join: tailing
      ? { emit: 'tail-pod', payload: { resourceId: showLogModal.id, podName: selectedPod, namespace } }
      : undefined,
    onChunk: (chunk) => { setKubeLogs((prev) => prev + chunk); setLastLogAt(Date.now()); },
    onReconnect: () => { setKubeLogs(''); setLastLogAt(null); },
  });

  /**
   * Keeps a real pod selected on the Pods tab.
   *
   * Pods are ephemeral: the one being tailed can be replaced by a rollout at any moment, and a
   * selection pointing at a name that no longer exists tails nothing while looking fine. This
   * re-picks the first available one and clears the buffer, because the new pod's history has
   * nothing to do with the old one's.
   */
  useEffect(() => {
    if (showLogModal.type === 'app' && logTab === 'app' && pods.length > 0) {
      const exists = pods.some((p) => p?.metadata?.name === selectedPod);
      if (!selectedPod || !exists) {
        setSelectedPod(pods[0]?.metadata?.name || null);
        setKubeLogs('');
        setLastLogAt(null);
      }
    }
  }, [showLogModal, logTab, pods, selectedPod]);


  /** Seeds the exposure-path field from the deployment when it opens. */
  useEffect(() => {
    if (currentDeployment) setExposurePathInput(currentDeployment.exposurePath || '');
  }, [currentDeployment?.id]);

  useEffect(() => {
    // scrollIntoView scrolls both axes; skip for diagnostics so its horizontal
    // scroll position (browsing the wide kubectl table) isn't reset every poll.
    if (logTab === 'diagnostics') return;
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [socketLogs, kubeLogs, helmStatus, diagnostics, logTab]);


  const invalidate = () => qc.invalidateQueries({ queryKey: deploymentKeys.all });

  /**
   * Public exposure is Localtunnel; local is an entry in the host's nginx. `mode` rides in the
   * variables rather than there being two mutations, because each button shows a spinner only for
   * its own mode — `exposeApp.variables?.mode` is what distinguishes them.
   */
  const exposeApp = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'public' | 'local' }) =>
      api.post(`/deployments/${id}/expose`, { mode }).then((r) => r.data),
    onSuccess: invalidate,
  });
  const unexposeApp = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'public' | 'local' }) =>
      api.post(`/deployments/${id}/unexpose`, { mode }).then((r) => r.data),
    onSuccess: invalidate,
  });

  /**
   * The config panel's state. Seeded from the deployment when it opens, then edited freely —
   * `key` on the modal means a different deployment remounts it rather than carrying values over.
   */
  const [configInputs, setConfigInputs] = useState({
    webRepo: '', webTag: '', dbRepo: '', dbTag: '',
    vllmModel: '', vllmGpuCount: '1', vllmGpuVendor: 'nvidia', vllmHfToken: '',
    vllmMaxModelLen: '', vllmGpuMemUtil: '', vllmExtraArgs: '',
    vllmToolCallingEnabled: false, vllmToolCallParser: '', vllmServedModelName: '',
    vllmMaxNumSeqs: '', vllmDtype: '', vllmEnablePrefixCaching: false,
    tabbyModel: '', tabbyRevision: '', tabbyGpuCount: '1', tabbyHfToken: '',
    tabbyImageTag: 'latest', tabbyCacheMode: '', tabbyMaxSeqLen: '', tabbyMaxBatchSize: '',
    tabbyReasoning: false, tabbyToolFormat: '', tabbyInlineModelLoading: false,
    tabbyDisableAuth: true, tabbyMemoryLimit: '', tabbyShmSize: '', tabbyCpuLimit: '', tabbyExtraEnv: '',
    openWebuiTargetId: '',
    hermesTargetId: '',
    webuiEnableWebSearch: true, webuiWebSearchEngine: 'duckduckgo', webuiWebSearchApiKey: '',
  });
  // Schema-driven settings for game servers, edited in the Config tab. Seeded from the deployment
  // record when the tab opens.
  const [gameSettings, setGameSettings] = useState<Record<string, string>>({});

  const updateAppModules = useMutation({
    mutationFn: ({ id, modules }: any) => api.patch(`/deployments/${id}/modules`, { modules }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setLogTab('provision');
    }
  });

  const updateAppConfig = useMutation({
    mutationFn: ({ id, patch }: { id: string, patch: Record<string, any> }) => api.patch(`/deployments/${id}/config`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setLogTab('provision');
    }
  });

  const updateExposurePath = useMutation({
    mutationFn: ({ id, path }: { id: string, path: string }) => api.patch(`/deployments/${id}/exposure-path`, { path }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    }
  });

  return (

    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center p-6 z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 w-full max-w-6xl h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-300">
        <div className="flex justify-between items-start mb-6">
          <div className="space-y-2 flex-1">
            <h3 className="text-2xl font-bold flex items-center gap-3">
              <FileText className="text-blue-500" />
              {showLogModal.type === 'app' ? `${currentDeployment?.name || 'Application'} Dashboard` : 'Execution Tracing'}
            </h3>
            <div className="flex gap-4 border-b border-slate-700">
              {showLogModal.type === 'app' ? (
                <>
                  <button onClick={() => setLogTab('general')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'general' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Server size={14} /> General</button>
                  <button onClick={() => setLogTab('provision')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'provision' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Terminal size={14} /> Provisioning</button>
                  <button onClick={() => setLogTab('app')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'app' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Cpu size={14} /> Container Logs</button>
                  <button onClick={() => setLogTab('helm')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'helm' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Layers size={14} /> Helm Status</button>
                  <button onClick={() => setLogTab('diagnostics')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'diagnostics' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><AlertTriangle size={14} /> Diagnostics</button>
                  <button onClick={() => setLogTab('modules')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'modules' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Puzzle size={14} /> Modules</button>
                  <button onClick={() => setLogTab('storage')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'storage' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Settings size={14} /> Config</button>
                </>
              ) : (
                <button onClick={() => setLogTab('provision')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'provision' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Terminal size={14} /> Infrastructure</button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {!(showLogModal.type === 'cluster' && currentCluster?.isSystem) && (
              <button
                onClick={() => {
                  const resource = showLogModal.type === 'app' ? currentDeployment : currentCluster;
                  const status = resource?.status;
                  setConfirmDestroy({
                    type: showLogModal.type,
                    id: showLogModal.id,
                    name: resource?.name || 'this resource',
                    isAbort: status === 'provisioning' || status === 'deploying',
                  });
                }}
                className="px-4 py-2 bg-slate-700/50 hover:bg-red-600 border border-slate-600 hover:border-red-500 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"
              >
                <Trash2 size={14} /> Destroy
              </button>
            )}
            <button onClick={() => {onClose(); setSelectedPod(null);}} aria-label="Close dashboard" className="text-slate-400 hover:text-white"><X size={24} /></button>
          </div>
        </div>
        <div className="flex-1 flex gap-6 min-h-0">
           {showLogModal.type === 'app' && logTab === 'app' && (
             <div className="w-64 bg-slate-900/50 rounded-xl border border-slate-700 p-4 overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Cpu size={12} /> Active Pods</div>
                  {podsCheckedAt ? <span className="text-[9px] text-slate-600" title="Last time the pod list was refreshed">checked {new Date(podsCheckedAt).toLocaleTimeString()}</span> : null}
                </div>
                <div className="space-y-2">
                   {pods.length > 0 ? pods.map((p: any) => (
                     <button key={p?.metadata?.name || Math.random()} onClick={() => {setSelectedPod(p.metadata.name); setKubeLogs(''); setLastLogAt(null);}} className={`w-full text-left p-3 rounded-lg text-xs transition-all border ${selectedPod === p?.metadata?.name ? 'bg-blue-600/20 border-blue-500 text-blue-100' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'}`}>
                       <div className="font-bold truncate">{p?.metadata?.name || 'Unknown'}</div>
                       <div className="flex items-center gap-1.5 mt-1 opacity-70"><div className={`w-1.5 h-1.5 rounded-full ${p?.status?.phase === 'Running' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>{p?.status?.phase || 'Pending'}</div>
                     </button>
                   )) : <div className="text-[10px] text-slate-600 italic text-center py-4">No pods detected.</div>}
                </div>
             </div>
           )}
           {logTab === 'modules' && currentDeployment && (
             <div className="flex-1 flex flex-col min-h-0">
                <div className="flex justify-between items-center mb-6">
                    <div><h4 className="text-xl font-bold">Module Marketplace</h4><p className="text-slate-400 text-xs">Manage custom addons for this instance.</p></div>
                    <button disabled={updateAppModules.isPending} onClick={() => updateAppModules.mutate({ id: currentDeployment.id, modules: currentDeployment.modules })} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-all">{updateAppModules.isPending ? <Loader2 size={16} className="animate-spin" /> : <><Check size={16} /> Apply Changes</>}</button>
                </div>
                {loadingModules ? (
                  <div className="flex-1 flex items-center justify-center"><Loader2 className="animate-spin text-slate-600" size={32} /></div>
                ) : (
                  <div className="grid grid-cols-2 gap-4 overflow-y-auto pr-2 custom-scrollbar">
                     {availableModules.map((mod: any) => {
                       const isEnabled = currentDeployment.modules?.includes(mod.id);
                       return (
                         <button key={mod.id} onClick={() => {
                           const current = currentDeployment.modules || [];
                           const next = isEnabled ? current.filter((id: string) => id !== mod.id) : [...current, mod.id];
                           queryClient.setQueryData(['deployments'], (prev: any) => prev.map((d: any) => d.id === currentDeployment.id ? { ...d, modules: next } : d));
                         }} className={`p-6 rounded-2xl border-2 text-left transition-all ${isEnabled ? 'border-green-500 bg-green-500/5' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'}`}>
                           <div className="flex justify-between items-start mb-4">
                              <div className={`p-3 rounded-xl ${isEnabled ? 'bg-green-500/20 text-green-500' : 'bg-slate-800 text-slate-400'}`}><Puzzle size={24} /></div>
                              <div className={`text-[10px] font-black uppercase px-2 py-1 rounded-md ${isEnabled ? 'bg-green-500 text-white' : 'bg-slate-800 text-slate-500'}`}>{isEnabled ? 'Enabled' : 'Disabled'}</div>
                           </div>
                           <div className="font-bold text-lg mb-1">{mod.name}</div>
                           <div className="text-xs text-slate-400 line-clamp-2 leading-relaxed">{mod.summary || mod.description}</div>
                           <div className="mt-4 pt-4 border-t border-slate-800/50 flex justify-between items-center text-[10px] font-bold text-slate-500"><span>By {mod.author}</span><span>v{mod.version}</span></div>
                         </button>
                       );
                     })}
                  </div>
                )}
             </div>
           )}
           {logTab === 'storage' && currentDeployment && (
              <div className="flex-1 flex flex-col gap-8 overflow-y-auto pr-2 custom-scrollbar min-h-0">
                 <div className="flex justify-between items-center">
                     <div>
                       <h4 className="text-xl font-bold">Application Configuration</h4>
                       <p className="text-slate-400 text-xs">Edit storage sizing and app-specific settings below, then save to re-apply the deployment and restart it.</p>
                     </div>
                     <button
                       disabled={updateAppConfig.isPending || (currentDeployment.status !== 'running' && currentDeployment.status !== 'failed')}
                       onClick={() => {
                         const appType = currentDeployment.appType || 'odoo';
                         const patch: Record<string, any> = { storage: storageInputs };
                         // Only the keys that actually differ from what's stored — the backend deep-merges
                         // appSettings, so sending the whole map would be wasteful and sending a partial one
                         // is safe.
                         if (NO_WEB_UI_APP_TYPES.has(appType)) {
                           const stored = currentDeployment.appSettings || {};
                           const dirty: Record<string, string> = {};
                           for (const [k, v] of Object.entries(gameSettings)) if (stored[k] !== v) dirty[k] = v;
                           if (Object.keys(dirty).length > 0) patch.appSettings = dirty;
                         }
                         if (appType === 'vllm') {
                           patch.vllmModel = configInputs.vllmModel;
                           patch.vllmGpuCount = parseInt(configInputs.vllmGpuCount) || 0;
                           patch.vllmGpuVendor = configInputs.vllmGpuVendor;
                           if (configInputs.vllmHfToken) patch.vllmHfToken = configInputs.vllmHfToken;
                           if (configInputs.vllmMaxModelLen) patch.vllmMaxModelLen = parseInt(configInputs.vllmMaxModelLen);
                           if (configInputs.vllmGpuMemUtil) patch.vllmGpuMemUtil = parseFloat(configInputs.vllmGpuMemUtil);
                           patch.vllmExtraArgs = configInputs.vllmExtraArgs;
                           patch.vllmToolCallingEnabled = configInputs.vllmToolCallingEnabled && !!configInputs.vllmToolCallParser;
                           if (configInputs.vllmToolCallParser) patch.vllmToolCallParser = configInputs.vllmToolCallParser;
                           if (configInputs.vllmServedModelName) patch.vllmServedModelName = configInputs.vllmServedModelName;
                           if (configInputs.vllmMaxNumSeqs) patch.vllmMaxNumSeqs = parseInt(configInputs.vllmMaxNumSeqs);
                           if (configInputs.vllmDtype) patch.vllmDtype = configInputs.vllmDtype;
                           patch.vllmEnablePrefixCaching = configInputs.vllmEnablePrefixCaching;
                         } else if (appType === 'tabbyapi') {
                           patch.tabbyModel = configInputs.tabbyModel;
                           patch.tabbyRevision = configInputs.tabbyRevision;
                           patch.tabbyGpuCount = parseInt(configInputs.tabbyGpuCount) || 0;
                           if (configInputs.tabbyHfToken) patch.tabbyHfToken = configInputs.tabbyHfToken;
                           patch.tabbyImageTag = configInputs.tabbyImageTag;
                           patch.tabbyCacheMode = configInputs.tabbyCacheMode;
                           if (configInputs.tabbyMaxSeqLen) patch.tabbyMaxSeqLen = parseInt(configInputs.tabbyMaxSeqLen);
                           if (configInputs.tabbyMaxBatchSize) patch.tabbyMaxBatchSize = parseInt(configInputs.tabbyMaxBatchSize);
                           patch.tabbyReasoning = configInputs.tabbyReasoning;
                           patch.tabbyToolFormat = configInputs.tabbyToolFormat;
                           patch.tabbyInlineModelLoading = configInputs.tabbyInlineModelLoading;
                           patch.tabbyDisableAuth = configInputs.tabbyDisableAuth;
                           patch.tabbyMemoryLimit = configInputs.tabbyMemoryLimit;
                           patch.tabbyShmSize = configInputs.tabbyShmSize;
                           patch.tabbyCpuLimit = configInputs.tabbyCpuLimit;
                           patch.tabbyExtraEnv = configInputs.tabbyExtraEnv;
                         } else if (appType === 'openwebui') {
                           patch.openWebuiTargetId = configInputs.openWebuiTargetId;
                           patch.webuiEnableWebSearch = configInputs.webuiEnableWebSearch;
                           patch.webuiWebSearchEngine = configInputs.webuiWebSearchEngine;
                           if (configInputs.webuiWebSearchApiKey) patch.webuiWebSearchApiKey = configInputs.webuiWebSearchApiKey;
                         } else if (appType === 'hermes') {
                           patch.hermesTargetId = configInputs.hermesTargetId;
                         } else {
                           patch.webRepo = configInputs.webRepo;
                           patch.webTag = configInputs.webTag;
                           if (APP_DEFAULTS[appType]?.hasDatabase) {
                             patch.dbRepo = configInputs.dbRepo;
                             patch.dbTag = configInputs.dbTag;
                           }
                         }
                         updateAppConfig.mutate({ id: currentDeployment.id, patch });
                       }}
                       className="bg-purple-600 hover:bg-purple-500 text-white px-6 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
                     >
                       {updateAppConfig.isPending ? <Loader2 size={16} className="animate-spin" /> : <><RefreshCw size={16} /> Save &amp; Restart</>}
                     </button>
                 </div>

                 {currentDeployment.appType === 'vllm' && (
                   <div className="border border-slate-700/60 bg-slate-900/40 rounded-2xl p-6 flex flex-col gap-4">
                     <h5 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2"><Cpu size={16} className="text-blue-400" /> vLLM Settings</h5>
                     <div className="grid grid-cols-2 gap-4">
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Model ID</label>
                         <input value={configInputs.vllmModel} onChange={e => setConfigInputs(prev => ({ ...prev, vllmModel: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. meta-llama/Llama-3.2-3B-Instruct" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Count</label>
                         <select value={configInputs.vllmGpuCount} onChange={e => setConfigInputs(prev => ({ ...prev, vllmGpuCount: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all"><option value="1">1 GPU</option><option value="2">2 GPUs</option><option value="4">4 GPUs</option><option value="0">CPU Only (No GPU)</option></select>
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Vendor</label>
                         <select value={configInputs.vllmGpuVendor} onChange={e => setConfigInputs(prev => ({ ...prev, vllmGpuVendor: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all"><option value="nvidia">NVIDIA CUDA</option><option value="amd">AMD ROCm</option></select>
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Token</label>
                         <input type="password" value={configInputs.vllmHfToken} onChange={e => setConfigInputs(prev => ({ ...prev, vllmHfToken: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="Leave blank to keep current token" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Model Length</label>
                         <input type="number" value={configInputs.vllmMaxModelLen} onChange={e => setConfigInputs(prev => ({ ...prev, vllmMaxModelLen: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. 32768" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Memory Utilization</label>
                         <input type="number" step="0.05" min="0" max="1" value={configInputs.vllmGpuMemUtil} onChange={e => setConfigInputs(prev => ({ ...prev, vllmGpuMemUtil: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. 0.9" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Served Model Name</label>
                         <input value={configInputs.vllmServedModelName} onChange={e => setConfigInputs(prev => ({ ...prev, vllmServedModelName: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="Alias exposed via the API — defaults to the model ID" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Concurrent Sequences</label>
                         <input type="number" value={configInputs.vllmMaxNumSeqs} onChange={e => setConfigInputs(prev => ({ ...prev, vllmMaxNumSeqs: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. 256 (--max-num-seqs)" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Data Type</label>
                         <select value={configInputs.vllmDtype} onChange={e => setConfigInputs(prev => ({ ...prev, vllmDtype: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all">
                           <option value="">Auto (model default)</option>
                           <option value="half">half / float16</option>
                           <option value="bfloat16">bfloat16</option>
                           <option value="float32">float32</option>
                         </select>
                       </div>
                       <div className="flex items-center gap-3 pt-6">
                         <input type="checkbox" id="cfg-prefix-caching" checked={configInputs.vllmEnablePrefixCaching} onChange={e => setConfigInputs(prev => ({ ...prev, vllmEnablePrefixCaching: e.target.checked }))} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                         <label htmlFor="cfg-prefix-caching" className="text-sm text-slate-300 cursor-pointer select-none">Enable Prefix Caching</label>
                       </div>
                     </div>

                     <div className="pt-2 border-t border-slate-800/80 flex flex-col gap-3">
                       <div className="flex items-center gap-3">
                         <input type="checkbox" id="cfg-tool-calling" checked={configInputs.vllmToolCallingEnabled} onChange={e => setConfigInputs(prev => ({ ...prev, vllmToolCallingEnabled: e.target.checked }))} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                         <label htmlFor="cfg-tool-calling" className="text-sm text-slate-300 cursor-pointer select-none">Enable Tool Calling</label>
                         <span className="text-[10px] text-slate-500 ml-auto">Required for OpenAI-style function/tool calls (used by Open WebUI's Tools, agents, etc.)</span>
                       </div>
                       {configInputs.vllmToolCallingEnabled && (
                         <div>
                           <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Tool Call Parser</label>
                           <select value={configInputs.vllmToolCallParser} onChange={e => setConfigInputs(prev => ({ ...prev, vllmToolCallParser: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all">
                             <option value="">Select a parser matching your model...</option>
                             <option value="llama3_json">llama3_json — Llama 3.x</option>
                             <option value="mistral">mistral — Mistral / Mixtral</option>
                             <option value="hermes">hermes — Hermes / Qwen</option>
                             <option value="granite">granite — Granite</option>
                             <option value="granite-20b-fc">granite-20b-fc — Granite 20B Function Calling</option>
                             <option value="internlm">internlm — InternLM</option>
                             <option value="jamba">jamba — Jamba</option>
                             <option value="pythonic">pythonic — Pythonic (Llama variants)</option>
                           </select>
                           {!configInputs.vllmToolCallParser && (
                             <p className="text-[11px] text-amber-400/80 mt-2">vLLM requires a parser whenever tool calling is enabled — "auto" tool choice will fail to start without one.</p>
                           )}
                         </div>
                       )}
                     </div>

                     <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Additional Arguments</label>
                       <textarea value={configInputs.vllmExtraArgs} onChange={e => setConfigInputs(prev => ({ ...prev, vllmExtraArgs: e.target.value }))} rows={2} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="Any other vllm serve flags, e.g. --swap-space 4" />
                     </div>
                   </div>
                 )}

                 {currentDeployment.appType === 'tabbyapi' && (
                   <div className="border border-slate-700/60 bg-slate-900/40 rounded-2xl p-6 flex flex-col gap-4">
                     <h5 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2"><Cpu size={16} className="text-blue-400" /> TabbyAPI Settings</h5>
                     <div className="grid grid-cols-2 gap-4">
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Model ID</label>
                         <input value={configInputs.tabbyModel} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyModel: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. bartowski/Llama-3.2-3B-Instruct-exl2" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Revision / Branch</label>
                         <input value={configInputs.tabbyRevision} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyRevision: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. 6.0bpw" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Count</label>
                         <select value={configInputs.tabbyGpuCount} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyGpuCount: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all"><option value="1">1 GPU</option><option value="2">2 GPUs</option><option value="4">4 GPUs</option></select>
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Token</label>
                         <input type="password" value={configInputs.tabbyHfToken} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyHfToken: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="Leave blank to keep current token" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cache Mode</label>
                         <select value={configInputs.tabbyCacheMode} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyCacheMode: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all">
                           <option value="">FP16 (default)</option>
                           <option value="Q8">Q8</option>
                           <option value="Q6">Q6</option>
                           <option value="Q4">Q4</option>
                         </select>
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Sequence Length</label>
                         <input type="number" value={configInputs.tabbyMaxSeqLen} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyMaxSeqLen: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. 32768" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Concurrent Generations</label>
                         <input type="number" value={configInputs.tabbyMaxBatchSize} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyMaxBatchSize: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="e.g. 8" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Image Variant</label>
                         <select value={configInputs.tabbyImageTag} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyImageTag: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all">
                           {tabbyImageTagOptions.length === 0 && <option value={configInputs.tabbyImageTag}>{loadingTabbyImageTags ? 'Checking available images...' : configInputs.tabbyImageTag}</option>}
                           {tabbyImageTagOptions.map(opt => (
                             <option key={opt.tag} value={opt.tag}>{opt.label}{opt.cached ? ' ✓ cached locally' : ''}</option>
                           ))}
                         </select>
                         {loadingTabbyImageTags && <p className="text-[11px] text-slate-500 mt-1">Fetching available tags from ghcr.io...</p>}
                       </div>
                       <div className="flex items-center gap-3 pt-6">
                         <input type="checkbox" id="cfg-tabby-reasoning" checked={configInputs.tabbyReasoning} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyReasoning: e.target.checked }))} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                         <label htmlFor="cfg-tabby-reasoning" className="text-sm text-slate-300 cursor-pointer select-none">Reasoning Model</label>
                       </div>
                       <div className="flex items-center gap-3 pt-6">
                         <input type="checkbox" id="cfg-tabby-inline" checked={configInputs.tabbyInlineModelLoading} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyInlineModelLoading: e.target.checked }))} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                         <label htmlFor="cfg-tabby-inline" className="text-sm text-slate-300 cursor-pointer select-none">Allow Inline Model Loading</label>
                       </div>
                       <div className="flex items-center gap-3 pt-6">
                         <input type="checkbox" id="cfg-tabby-auth" checked={!configInputs.tabbyDisableAuth} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyDisableAuth: !e.target.checked }))} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                         <label htmlFor="cfg-tabby-auth" className="text-sm text-slate-300 cursor-pointer select-none">Require API Key</label>
                       </div>
                     </div>

                     <div className="grid grid-cols-3 gap-3">
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Memory Limit (RAM)</label>
                         <input value={configInputs.tabbyMemoryLimit} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyMemoryLimit: e.target.value }))} title={resourcePlan?.basis ? `Computed from ${resourcePlan.basis}` : undefined} placeholder={resourcePlan?.memoryLimit ? `${resourcePlan.memoryLimit} — sized from the model` : 'e.g. 32G, 48G, 64G'} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" />
                         {resourcePlan?.refusal && (
                           // Said where the number is chosen, not after a pod has been killed.
                           <p className="text-[11px] text-amber-400 mt-1">{resourcePlan.refusal}</p>
                         )}
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Shared Memory (/dev/shm)</label>
                         <input value={configInputs.tabbyShmSize} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyShmSize: e.target.value }))} placeholder="e.g. 16Gi, 24Gi, 32Gi" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">CPU Cores Limit</label>
                         <input value={configInputs.tabbyCpuLimit} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyCpuLimit: e.target.value }))} placeholder="e.g. 10, 16" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" />
                       </div>
                     </div>

                     <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Tool Call Format</label>
                       <select value={configInputs.tabbyToolFormat} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyToolFormat: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all">
                         <option value="">None — tool calls won't be parsed</option>
                         {TABBY_TOOL_FORMATS.map(fmt => <option key={fmt} value={fmt}>{fmt}</option>)}
                       </select>
                     </div>

                     <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Additional Config (env overrides)</label>
                       <textarea value={configInputs.tabbyExtraEnv} onChange={e => setConfigInputs(prev => ({ ...prev, tabbyExtraEnv: e.target.value }))} rows={2} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="One per line, e.g. TABBY_MODEL_CHUNK_SIZE=4096" />
                     </div>
                   </div>
                 )}

                 {currentDeployment.appType === 'openwebui' && (
                   <div className="border border-slate-700/60 bg-slate-900/40 rounded-2xl p-6 flex flex-col gap-4">
                     <h5 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2"><Cpu size={16} className="text-blue-400" /> Open WebUI Settings</h5>
                     <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">LLM Backend (vLLM / TabbyAPI Deployment)</label>
                       <select value={configInputs.openWebuiTargetId} onChange={e => setConfigInputs(prev => ({ ...prev, openWebuiTargetId: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all">
                         <option value="">No backend (configure manually in Open WebUI)</option>
                         {deployments.filter((d: any) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === currentDeployment.clusterId).map((d: any) => (
                           <option key={d.id} value={d.id}>{d.name} ({d.vllmModel || d.tabbyModel || (d.appType === 'tabbyapi' ? 'TabbyAPI' : 'vLLM')})</option>
                         ))}
                       </select>
                       <p className="text-[11px] text-slate-500 mt-1">Only vLLM/TabbyAPI deployments on the same cluster are listed — Open WebUI reaches them over the cluster's internal network.</p>
                     </div>
                     <div className="flex items-center justify-between">
                       <div>
                         <div className="text-sm font-bold text-slate-200">Web Search</div>
                         <div className="text-xs text-slate-400 mt-0.5">Off by default the model has no internet access at all.</div>
                       </div>
                       <button
                         type="button"
                         onClick={() => setConfigInputs(prev => ({ ...prev, webuiEnableWebSearch: !prev.webuiEnableWebSearch }))}
                         className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${configInputs.webuiEnableWebSearch ? 'bg-blue-600' : 'bg-slate-700'}`}
                       >
                         <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${configInputs.webuiEnableWebSearch ? 'translate-x-6' : 'translate-x-1'}`} />
                       </button>
                     </div>
                     {configInputs.webuiEnableWebSearch && (
                       <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                         <div>
                           <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Search Engine</label>
                           <select value={configInputs.webuiWebSearchEngine} onChange={e => setConfigInputs(prev => ({ ...prev, webuiWebSearchEngine: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all">
                             <option value="duckduckgo">DuckDuckGo — no API key needed</option>
                             <option value="tavily">Tavily</option>
                             <option value="brave">Brave Search</option>
                             <option value="serper">Serper</option>
                             <option value="bing">Bing</option>
                           </select>
                         </div>
                         {configInputs.webuiWebSearchEngine !== 'duckduckgo' && (
                           <div>
                             <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">API Key</label>
                             <input type="password" value={configInputs.webuiWebSearchApiKey} onChange={e => setConfigInputs(prev => ({ ...prev, webuiWebSearchApiKey: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 font-mono focus:border-blue-500 focus:outline-none transition-all" placeholder="Leave blank to keep current key" />
                           </div>
                         )}
                       </div>
                     )}
                   </div>
                 )}

                 {NO_WEB_UI_APP_TYPES.has(currentDeployment.appType || '') && (
                   <GameServerSettings
                     apiBase={API_BASE}
                     appType={currentDeployment.appType!}
                     value={gameSettings}
                     onChange={setGameSettings}
                   />
                 )}

                 {!NO_WEB_UI_APP_TYPES.has(currentDeployment.appType || '') && currentDeployment.appType !== 'vllm' && currentDeployment.appType !== 'tabbyapi' && currentDeployment.appType !== 'openwebui' && currentDeployment.appType !== 'hermes' && (
                   <div className="border border-slate-700/60 bg-slate-900/40 rounded-2xl p-6 flex flex-col gap-4">
                     <h5 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2"><Layers size={16} className="text-indigo-400" /> Image Version</h5>
                     <div className="grid grid-cols-2 gap-4">
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label>
                         <input value={configInputs.webRepo} onChange={e => setConfigInputs(prev => ({ ...prev, webRepo: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" />
                       </div>
                       <div>
                         <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Tag</label>
                         <input value={configInputs.webTag} onChange={e => setConfigInputs(prev => ({ ...prev, webTag: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" />
                       </div>
                       {APP_DEFAULTS[currentDeployment.appType || 'odoo']?.hasDatabase && (
                         <>
                           <div>
                             <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Database Repository</label>
                             <input value={configInputs.dbRepo} onChange={e => setConfigInputs(prev => ({ ...prev, dbRepo: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" />
                           </div>
                           <div>
                             <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Database Tag</label>
                             <input value={configInputs.dbTag} onChange={e => setConfigInputs(prev => ({ ...prev, dbTag: e.target.value }))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all" />
                           </div>
                         </>
                       )}
                     </div>
                   </div>
                 )}

                 <div>
                   <h5 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2 mb-4"><HardDrive size={16} className="text-purple-400" /> Storage Volumes</h5>
                 {getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy || '').length === 0 ? (
                   <div className="flex-1 flex items-center justify-center border border-slate-700/50 rounded-2xl bg-slate-900/20 p-8">
                     <div className="text-center max-w-sm space-y-4">
                       <div className="inline-flex p-4 bg-slate-800 rounded-full border border-slate-700 text-slate-500">
                         <HardDrive size={32} />
                       </div>
                       <h5 className="text-base font-bold text-slate-300">No Volumes Configured</h5>
                       <p className="text-xs text-slate-500 leading-relaxed">
                         This application strategy does not use or support dynamic persistent volume claims.
                       </p>
                     </div>
                   </div>
                 ) : (
                   <div className="grid grid-cols-2 gap-4 overflow-y-auto pr-2 custom-scrollbar">
                      {getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy || '').map((vol: string) => {
                        const currentVal = currentDeployment.storage?.[vol] || getFallbackSize(vol);
                        const iconMap: Record<string, React.ReactNode> = {
                          db: <Database className="text-blue-400" size={24} />,
                          web: <Layers className="text-indigo-400" size={24} />,
                          library: <HardDrive className="text-purple-400" size={24} />,
                          metadata: <Box className="text-pink-400" size={24} />,
                          config: <Server className="text-orange-400" size={24} />,
                          server: <Activity className="text-amber-400" size={24} />
                        };
                        const nameMap: Record<string, string> = {
                          db: 'Database Volume',
                          web: 'Web Assets Volume',
                          library: 'Library Volume',
                          metadata: 'Metadata Volume',
                          config: 'Config Volume',
                          server: 'Server Storage'
                        };
                        return (
                          <div key={vol} className="p-6 rounded-2xl border border-slate-700 bg-slate-900/50 flex flex-col justify-between gap-4">
                           <div className="flex justify-between items-start">
                              <div className="flex gap-4">
                                 <div className="p-3 rounded-xl bg-slate-800 text-slate-400">{iconMap[vol] || <HardDrive size={24} />}</div>
                                 <div>
                                    <div className="font-bold text-base text-slate-200">{nameMap[vol] || vol}</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5 uppercase font-mono tracking-wider">Key: {vol}</div>
                                 </div>
                              </div>
                              <div className="text-[10px] font-black uppercase px-2 py-1 rounded bg-slate-800 text-slate-400 border border-slate-700">
                                 Current: {String(currentVal)}
                              </div>
                           </div>
                           <div className="text-xs text-slate-400 leading-relaxed min-h-[32px]">{getVolumeDescription(vol)}</div>
                           <div className="mt-2 flex items-center gap-4">
                             <label htmlFor={`vol-size-${vol}`} className="text-xs text-slate-500 font-bold whitespace-nowrap">Target Size:</label>
                             <div className="relative flex-1">
                               <input 
                                 id={`vol-size-${vol}`}
                                 type="text" 
                                 value={storageInputs[vol] || ''} 
                                 onChange={(e) => setStorageInputs(prev => ({ ...prev, [vol]: e.target.value }))}
                                 className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all"
                                 placeholder="e.g. 5Gi"
                               />
                             </div>
                           </div>
                          </div>
                        );
                      })}
                   </div>
                 )}
                 </div>
              </div>
            )}
           {logTab === 'general' && currentDeployment && (
             <div className="flex-1 flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar">
                {/*
                  * A deploy that failed and a workload that will not start are different
                  * problems with different evidence, and the deployment log only explains the
                  * first. Sending someone to it for a CrashLoopBackOff wastes their time: the
                  * deploy succeeded, so its log ends in success.
                  */}
                {currentDeployment.status === 'unhealthy' && (
                  <div className="bg-amber-950/20 border-2 border-amber-500/30 rounded-2xl p-6 flex flex-col gap-4 animate-in fade-in duration-300">
                    <div className="flex items-center gap-3 text-amber-400">
                      <AlertTriangle size={24} />
                      <h4 className="font-bold text-lg">Deployed, but not running</h4>
                    </div>
                    <p className="text-slate-300 text-sm">
                      The deploy finished and the Kubernetes objects were created correctly — the
                      container inside them isn't staying up. The pod is left in place so its logs
                      and events survive; destroy this deployment when you're done looking.
                    </p>
                    {currentDeployment.healthReason && (
                      <div className="bg-slate-950 rounded-xl p-4 font-mono text-[11px] whitespace-pre-wrap border border-amber-500/20 text-amber-200/90 leading-relaxed shadow-inner">
                        {currentDeployment.healthReason}
                      </div>
                    )}
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      The deployment log won't explain this one — it ends in success. Use{' '}
                      <code className="text-amber-300/90">
                        kubectl logs -n {(currentDeployment.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-')} --previous -l app
                      </code>{' '}
                      to see why the container exited.
                    </p>
                  </div>
                )}
                {currentDeployment.status === 'failed' && (
                  <div className="bg-red-950/20 border-2 border-red-500/30 rounded-2xl p-6 flex flex-col gap-4 animate-in fade-in duration-300">
                    <div className="flex items-center gap-3 text-red-400">
                      <AlertTriangle size={24} />
                      <h4 className="font-bold text-lg">Deployment Failed</h4>
                    </div>
                    <p className="text-slate-300 text-sm">
                      An error occurred during the provisioning process. Below is the end of the deployment logs:
                    </p>
                    <div className="bg-slate-950 rounded-xl p-4 font-mono text-[11px] overflow-y-auto whitespace-pre-wrap border border-red-500/20 text-red-200/90 leading-relaxed max-h-60 shadow-inner">
                      {initialLogs?.content ? initialLogs.content.trim().split('\n').slice(-15).join('\n') : 'No provisioning logs found.'}
                    </div>
                    <div className="flex justify-end">
                      <button
                        onClick={() => setLogTab('provision')}
                        className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg shadow-red-950/50"
                      >
                        <Terminal size={14} /> View Full Logs
                      </button>
                    </div>
                  </div>
                )}
               <div className="grid grid-cols-4 gap-6">
                 <div className="bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl">
                   <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1">Status</div>
                   <div className="flex items-center gap-2">
                     {/* Amber for unhealthy: it deployed, so it is not the same red as a deploy that never landed. */}
                     <div className={`w-2.5 h-2.5 rounded-full ${currentDeployment.status === 'running' ? 'bg-green-500' : currentDeployment.status === 'deploying' ? 'bg-yellow-500 animate-pulse' : currentDeployment.status === 'unhealthy' ? 'bg-amber-500' : 'bg-red-500'}`}></div>
                     <span className="font-bold text-lg uppercase text-slate-200">{currentDeployment.status}</span>
                   </div>
                 </div>
                 <div className="bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl">
                   <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1">Application Type</div>
                   <span className="font-bold text-lg text-slate-200 uppercase">{currentDeployment.appType || 'odoo'}</span>
                 </div>
                 <div className="bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl">
                   <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1">Orchestration</div>
                   <span className="font-bold text-lg text-slate-200 uppercase">{currentDeployment.strategy || 'helm'}</span>
                 </div>
                 <div className="bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl">
                    <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1">VPN Routing</div>
                    <span className="font-bold text-lg text-slate-200 uppercase flex items-center gap-1.5">
                      {currentDeployment.vpnEnabled ? (
                        <span className="text-green-400 flex items-center gap-1">
                          <Shield size={16} /> Active ({currentDeployment.vpnProtocol})
                        </span>
                      ) : (
                        <span className="text-slate-500">Disabled</span>
                      )}
                    </span>
                  </div>
               </div>

               {NO_WEB_UI_APP_TYPES.has(currentDeployment.appType || '') ? (
                 <div className="bg-gradient-to-r from-blue-950/30 to-indigo-950/30 border border-blue-500/20 rounded-2xl p-8 flex flex-col gap-4">
                   <h4 className="text-xl font-bold flex items-center gap-2"><Zap className="text-blue-400" size={20} /> How players connect</h4>
                   <p className="text-slate-400 text-sm leading-relaxed max-w-2xl">
                     This is a UDP game server, so it doesn't go through the Nginx/tunnel proxy that
                     web apps use — players connect straight to the cluster node on the game port.
                   </p>
                   <div className="flex items-center gap-3">
                     <code className="px-4 py-2 rounded-xl bg-slate-950 border border-slate-800 text-blue-300 font-mono text-sm">
                       {(clusters.find((c: any) => c.id === currentDeployment.clusterId)?.remoteHost) || '<node-ip>'}:8211
                     </code>
                     <span className="text-[11px] text-slate-500">
                       Enter this under “Join via IP” in Palworld.
                     </span>
                   </div>
                   <p className="text-[11px] text-slate-600 leading-relaxed">
                     On a local k3d cluster this port isn't published to your host, so the server
                     won't be reachable from outside the cluster — that needs a real VM (Hetzner CX53
                     or larger), where the firewall rule for 8211/udp is created automatically.
                   </p>
                 </div>
               ) : (
               <div className="bg-gradient-to-r from-blue-950/30 to-indigo-950/30 border border-blue-500/20 rounded-2xl p-8 flex flex-col gap-6">
                 <div>
                   <h4 className="text-xl font-bold mb-2 flex items-center gap-2"><Zap className="text-blue-400" size={20} /> Network Exposure</h4>
                   <p className="text-slate-400 text-sm leading-relaxed max-w-2xl">
                     Expose this application publicly over our dynamic Nginx + tunnel reverse proxy, locally (reachable only from this machine, no tunnel), or both at once — independently toggleable.
                   </p>
                 </div>

                 <div className="flex flex-col gap-4 pt-4 border-t border-slate-800/80">
                   <div className="flex items-center gap-4 flex-wrap">
                     {currentDeployment.status === 'running' ? (
                       <>
                         {currentDeployment.isExposedPublicly ? (
                           <button
                             disabled={(exposeApp.isPending && exposeApp.variables?.mode === 'public') || (unexposeApp.isPending && unexposeApp.variables?.mode === 'public')}
                             onClick={() => unexposeApp.mutate({ id: currentDeployment.id, mode: 'public' })}
                             className="px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
                           >
                             {unexposeApp.isPending && unexposeApp.variables?.mode === 'public' ? <Loader2 size={18} className="animate-spin" /> : <X size={18} />}
                             Unexpose Publicly
                           </button>
                         ) : (
                           <button
                             disabled={exposeApp.isPending && exposeApp.variables?.mode === 'public'}
                             onClick={() => exposeApp.mutate({ id: currentDeployment.id, mode: 'public' })}
                             className="px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20 disabled:opacity-50"
                           >
                             {exposeApp.isPending && exposeApp.variables?.mode === 'public' ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                             Expose Publicly
                           </button>
                         )}
                         {currentDeployment.isExposedLocally ? (
                           <button
                             disabled={(exposeApp.isPending && exposeApp.variables?.mode === 'local') || (unexposeApp.isPending && unexposeApp.variables?.mode === 'local')}
                             onClick={() => unexposeApp.mutate({ id: currentDeployment.id, mode: 'local' })}
                             className="px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
                           >
                             {unexposeApp.isPending && unexposeApp.variables?.mode === 'local' ? <Loader2 size={18} className="animate-spin" /> : <X size={18} />}
                             Unexpose Locally
                           </button>
                         ) : (
                           <button
                             disabled={exposeApp.isPending && exposeApp.variables?.mode === 'local'}
                             onClick={() => exposeApp.mutate({ id: currentDeployment.id, mode: 'local' })}
                             className="px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all bg-slate-700 hover:bg-slate-600 text-white disabled:opacity-50"
                           >
                             {exposeApp.isPending && exposeApp.variables?.mode === 'local' ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                             Expose Locally
                           </button>
                         )}
                       </>
                     ) : (
                       <div className="text-sm font-semibold text-yellow-500 bg-yellow-500/10 px-4 py-2.5 rounded-lg border border-yellow-500/20 flex items-center gap-2">
                         <AlertTriangle size={16} /> Exposure controls are only available when the deployment is running.
                       </div>
                     )}
                   </div>

                   {(currentDeployment.isExposedPublicly || currentDeployment.isExposedLocally) && (
                      <div className="mt-4 p-6 bg-slate-900/60 border border-slate-700/80 rounded-2xl flex flex-col gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
                        {currentDeployment.isExposedPublicly && currentDeployment.publicExposureUrl && (
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-[10px] font-black uppercase text-green-500 tracking-wider mb-1 flex items-center gap-1.5">
                                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                                Public Access URL
                              </div>
                              <a href={currentDeployment.publicExposureUrl + (currentDeployment.exposurePath || '')} target="_blank" rel="noreferrer" className="group flex items-center gap-1.5 text-lg font-bold text-blue-400 hover:text-blue-300 transition-colors">
                                <span>{currentDeployment.publicExposureUrl}{currentDeployment.exposurePath || ''}</span>
                                <ExternalLink size={16} className="opacity-70 group-hover:opacity-100 transition-opacity" />
                              </a>
                            </div>
                            <span className="text-[10px] font-bold px-3 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 uppercase tracking-wider">Active</span>
                          </div>
                        )}
                        {currentDeployment.isExposedLocally && currentDeployment.localExposureUrl && (
                          <div className={`flex items-center justify-between ${currentDeployment.isExposedPublicly ? 'pt-4 border-t border-slate-800/80' : ''}`}>
                            <div>
                              <div className="text-[10px] font-black uppercase text-amber-500 tracking-wider mb-1 flex items-center gap-1.5">
                                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                Local Access URL
                              </div>
                              <a href={currentDeployment.localExposureUrl + (currentDeployment.exposurePath || '')} target="_blank" rel="noreferrer" className="group flex items-center gap-1.5 text-lg font-bold text-blue-400 hover:text-blue-300 transition-colors">
                                <span>{currentDeployment.localExposureUrl}{currentDeployment.exposurePath || ''}</span>
                                <ExternalLink size={16} className="opacity-70 group-hover:opacity-100 transition-opacity" />
                              </a>
                            </div>
                            <span className="text-[10px] font-bold px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider">Active</span>
                          </div>
                        )}

                        <div className="pt-4 border-t border-slate-800/80 flex flex-col gap-2">
                          <label htmlFor="exposure-path-input" className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Target Route Path</label>
                          <div className="flex items-center gap-3">
                            <div className="flex-1 flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-300 focus-within:border-blue-500/50 transition-all font-mono">
                              <span className="text-slate-600 select-none">{currentDeployment.exposureUrl}</span>
                              <input
                                id="exposure-path-input"
                                type="text"
                                placeholder="/path/to/app"
                                value={exposurePathInput}
                                onChange={(e) => setExposurePathInput(e.target.value)}
                                onBlur={() => updateExposurePath.mutate({ id: currentDeployment.id, path: exposurePathInput })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    updateExposurePath.mutate({ id: currentDeployment.id, path: exposurePathInput });
                                    e.currentTarget.blur();
                                  }
                                }}
                                className="flex-1 bg-transparent border-0 focus:ring-0 focus:outline-none p-0 ml-0.5 text-slate-200 font-mono text-xs leading-relaxed"
                              />
                            </div>
                            <button
                              type="button"
                              disabled={updateExposurePath.isPending}
                              onClick={() => updateExposurePath.mutate({ id: currentDeployment.id, path: exposurePathInput })}
                              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                            >
                              {updateExposurePath.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              Save Route
                            </button>
                          </div>
                          <span className="text-[10px] text-slate-500 leading-normal">
                            Edit the sub-path appended to the exposure URL (e.g. <code>/web/database/selector</code>). Saves automatically on blur or pressing Enter.
                          </span>
                        </div>
                      </div>
                    )}
                 </div>
               </div>
               )}
             </div>
           )}
{logTab !== 'modules' && logTab !== 'general' && logTab !== 'storage' && (
              <div className={`flex-1 bg-slate-950 rounded-xl p-6 font-mono text-[11px] overflow-y-auto border border-slate-700/50 shadow-inner custom-scrollbar text-blue-100/90 leading-relaxed relative ${logTab === 'diagnostics' ? 'overflow-x-auto whitespace-pre' : 'whitespace-pre-wrap'}`}>
                 {logTab === 'app' && selectedPod && (
                   <div className="sticky top-0 float-right ml-4 mb-2 text-[9px] text-slate-600 bg-slate-950/90 px-2 py-1 rounded-lg border border-slate-800" title="Last time a new log line arrived over the socket">
                     {lastLogAt ? `last log ${new Date(lastLogAt).toLocaleTimeString()}` : 'waiting for logs...'}
                   </div>
                 )}
                 {logTab === 'provision' ? <AnsiText text={((initialLogs?.content || '') + socketLogs) || 'Loading flow...'} /> :
                 logTab === 'helm' ? <AnsiText text={helmStatus?.content || 'Fetching Helm...'} /> :
                 logTab === 'diagnostics' ? <AnsiText text={diagnostics?.content || 'Scanning cluster for errors...'} /> :
                 (selectedPod ? <AnsiText text={kubeLogs || `Connected...`} /> : 'Select a pod to begin tailing.')}
                <div ref={logEndRef} />
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
