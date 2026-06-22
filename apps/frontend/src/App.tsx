import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Layout, Server, Plus, Cloud, Terminal, FileText, X, Trash2, Zap, Cpu, Loader2, AlertTriangle, BellRing, ChevronDown, ChevronUp, Check, ArrowRight, ArrowLeft, Package, Database, Layers, Activity, Box, Blocks, ExternalLink, Puzzle } from 'lucide-react';

const API_BASE = 'http://localhost:3001/api';
const SOCKET_URL = 'http://localhost:3001';

function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'clusters' | 'apps'>('clusters');
  const [showClusterModal, setShowClusterModal] = useState(false);
  const [showAppModal, setShowAppModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState<{ type: 'cluster' | 'app', id: string } | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState<{ type: 'cluster' | 'app', id: string, name: string } | null>(null);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<any[]>([]);
  
  const [logTab, setLogTab] = useState<'provision' | 'helm' | 'app' | 'diagnostics' | 'modules'>('provision');
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [socketLogs, setSocketLogs] = useState<string>('');
  const [kubeLogs, setKubeLogs] = useState<string>('');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Unified Wizard State
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState({
    name: 'Odoo-Production',
    clusterId: '',
    strategy: 'helm' as 'helm' | 'native',
    odooRepo: 'bitnami/odoo',
    odooTag: '18.0.20250805-debian-12-r8',
    pgRepo: 'bitnami/postgresql',
    pgTag: '17.5.0-debian-12-r20',
    modules: [] as string[]
  });

  const { data: clusters = [] } = useQuery({ queryKey: ['clusters'], queryFn: () => axios.get(`${API_BASE}/clusters`).then(res => res.data), refetchInterval: 3000 });
  const { data: deployments = [] } = useQuery({ queryKey: ['deployments'], queryFn: () => axios.get(`${API_BASE}/deployments`).then(res => res.data), refetchInterval: 3000 });
  
  const { data: clusterPods, isLoading: loadingClusterPods, error: podError } = useQuery({ 
    queryKey: ['cluster-pods', expandedCluster], 
    queryFn: () => axios.get(`${API_BASE}/clusters/${expandedCluster}/all-pods`).then(res => res.data), 
    enabled: !!expandedCluster, 
    refetchInterval: 5000 
  });

  const { data: clusterHelmReleases, isLoading: loadingClusterHelm } = useQuery({ 
    queryKey: ['cluster-helm', expandedCluster], 
    queryFn: () => axios.get(`${API_BASE}/clusters/${expandedCluster}/helm-releases`).then(res => res.data), 
    enabled: !!expandedCluster, 
    refetchInterval: 5000 
  });

  const { data: podResponse } = useQuery({ 
    queryKey: ['pods', showLogModal?.id], 
    queryFn: () => axios.get(`${API_BASE}/deployments/${showLogModal?.id}/pods`).then(res => res.data), 
    enabled: !!showLogModal && showLogModal.type === 'app' && logTab === 'app', 
    refetchInterval: 3000 
  });
  
  const pods = podResponse?.pods || [];
  const namespace = podResponse?.namespace || 'odoo';

  const { data: helmStatus } = useQuery({ queryKey: ['helm', showLogModal?.id], queryFn: () => axios.get(`${API_BASE}/deployments/${showLogModal?.id}/helm`).then(res => res.data), enabled: !!showLogModal && showLogModal.type === 'app' && logTab === 'helm', refetchInterval: 3000 });
  const { data: diagnostics } = useQuery({ queryKey: ['diagnostics', showLogModal?.id], queryFn: () => axios.get(`${API_BASE}/deployments/${showLogModal?.id}/diagnostics`).then(res => res.data), enabled: !!showLogModal && showLogModal.type === 'app' && logTab === 'diagnostics', refetchInterval: 3000 });
  
  // Custom Modules Queries
  const { data: availableModules = [], isLoading: loadingModules } = useQuery({ queryKey: ['modules'], queryFn: () => axios.get(`${API_BASE}/modules`).then(res => res.data), enabled: !!showLogModal && logTab === 'modules' });

  const { data: odooTags = [], isLoading: loadingOdooTags } = useQuery({ queryKey: ['tags', wizardData.odooRepo], queryFn: () => axios.get(`${API_BASE}/registry/tags?repo=${wizardData.odooRepo}`).then(res => res.data), enabled: showAppModal && wizardStep === 3 });
  const { data: pgTags = [], isLoading: loadingPgTags } = useQuery({ queryKey: ['tags', wizardData.pgRepo], queryFn: () => axios.get(`${API_BASE}/registry/tags?repo=${wizardData.pgRepo}`).then(res => res.data), enabled: showAppModal && wizardStep === 4 });

  const { data: initialLogs } = useQuery({ queryKey: ['logs', showLogModal?.type, showLogModal?.id], queryFn: () => axios.get(`${API_BASE}/logs/${showLogModal?.type}/${showLogModal?.id}`).then(res => res.data), enabled: !!showLogModal && logTab === 'provision' });

  useEffect(() => { if (initialLogs?.content && logTab === 'provision') setSocketLogs(initialLogs.content); }, [initialLogs, logTab]);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socket.on('resource-destroyed', (data) => {
        const nid = Date.now();
        setNotifications(prev => [...prev, { ...data, nid }]);
        queryClient.invalidateQueries({ queryKey: ['clusters'] });
        queryClient.invalidateQueries({ queryKey: ['deployments'] });
        setTimeout(() => setNotifications(prev => prev.filter(n => n.nid !== nid)), 5000);
    });
    return () => { socket.disconnect(); };
  }, [queryClient]);

  useEffect(() => {
    if (showLogModal) {
      const socket = io(SOCKET_URL);
      socket.emit('join-room', showLogModal.id);
      socket.on('log', (chunk: string) => setSocketLogs(prev => prev + chunk));
      if (showLogModal.type === 'app' && logTab === 'app' && selectedPod) {
          socket.emit('join-kube-room', showLogModal.id);
          const currentNamespace = podResponse?.namespace || 'odoo';
          socket.emit('tail-pod', { resourceId: showLogModal.id, podName: selectedPod, namespace: currentNamespace });
          socket.on('kube-log', (chunk: string) => setKubeLogs(prev => prev + chunk));
      }
      return () => {
        socket.emit('leave-room', showLogModal.id);
        if (showLogModal.type === 'app') socket.emit('leave-kube-room', showLogModal.id);
        socket.disconnect();
        setSocketLogs('');
        setKubeLogs('');
      };
    }
  }, [showLogModal, logTab, selectedPod, podResponse, namespace]);

  useEffect(() => { if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' }); }, [socketLogs, kubeLogs, helmStatus, diagnostics]);

  const provisionCluster = useMutation({ mutationFn: (newCluster: any) => axios.post(`${API_BASE}/clusters`, newCluster), onSuccess: (res) => { queryClient.invalidateQueries({ queryKey: ['clusters'] }); setShowClusterModal(false); setShowLogModal({ type: 'cluster', id: res.data.id }); setLogTab('provision'); } });
  
  const deployApp = useMutation({ 
    mutationFn: (newApp: any) => axios.post(`${API_BASE}/deployments`, newApp), 
    onSuccess: (res) => { 
      queryClient.invalidateQueries({ queryKey: ['deployments'] }); 
      setShowAppModal(false); 
      setShowLogModal({ type: 'app', id: res.data.id }); 
      setLogTab('provision'); 
      setWizardStep(1);
    } 
  });

  const updateAppModules = useMutation({
    mutationFn: ({ id, modules }: any) => axios.patch(`${API_BASE}/deployments/${id}/modules`, { modules }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setLogTab('provision');
    }
  });

  const destroyResource = useMutation({
    mutationFn: ({ type, id }: any) => axios.delete(`${API_BASE}/${type === 'cluster' ? 'clusters' : 'deployments'}/${id}`),
    onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: ['clusters'] });
        queryClient.invalidateQueries({ queryKey: ['deployments'] });
        setConfirmDestroy(null);
        setShowLogModal({ type: variables.type, id: variables.id });
        setLogTab('provision');
    }
  });

  const nextStep = () => setWizardStep(s => s + 1);
  const prevStep = () => setWizardStep(s => s - 1);

  const selectStrategy = (strat: 'helm' | 'native') => {
    if (strat === 'helm') {
      setWizardData({ ...wizardData, strategy: 'helm', odooRepo: 'bitnami/odoo', pgRepo: 'bitnami/postgresql', odooTag: '18.0.20250805-debian-12-r8', pgTag: '17.5.0-debian-12-r20' });
    } else {
      setWizardData({ ...wizardData, strategy: 'native', odooRepo: 'library/odoo', pgRepo: 'library/postgres', odooTag: '18.0', pgTag: '16.4' });
    }
  };

  const currentDeployment = showLogModal?.type === 'app' ? deployments.find((d: any) => d.id === showLogModal.id) : null;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex font-sans overflow-hidden">
      <aside className="w-64 bg-slate-800 border-r border-slate-700 p-6 flex flex-col shadow-xl z-20">
        <div className="flex items-center gap-2 mb-10"><Layout className="text-blue-500" /><h1 className="text-xl font-bold tracking-tight">Provisioner v2</h1></div>
        <nav className="space-y-2 flex-1">
          <button onClick={() => setView('clusters')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'clusters' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}><Cloud size={20} /> Clusters</button>
          <button onClick={() => setView('apps')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'apps' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}><Server size={20} /> Applications</button>
        </nav>
        <div className="pt-6 border-t border-slate-700 flex items-center gap-3 text-slate-500 text-[10px] uppercase font-black tracking-widest"><Terminal size={14} /> <span>Local Ops Active</span></div>
      </aside>

      <main className="flex-1 p-10 overflow-y-auto relative">
        <div className="fixed top-6 right-6 z-[60] space-y-3">
          {notifications.map(n => (<div key={n.nid} className="bg-slate-800 border-l-4 border-green-500 p-4 rounded-lg shadow-2xl flex items-center gap-4 min-w-[300px] animate-in slide-in-from-right"><BellRing className="text-green-500" size={20} /><div><div className="text-[10px] font-black uppercase text-slate-500 tracking-tighter">System Event</div><div className="text-sm font-bold">{n.name} Destroyed</div></div></div>))}
        </div>

        {view === 'clusters' ? (
          <section>
            <header className="flex justify-between items-center mb-10"><div><h2 className="text-3xl font-bold">Infrastructures</h2><p className="text-slate-400">Manage your Kubernetes fleet.</p></div><button onClick={() => setShowClusterModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105"><Plus size={20} /> Provision Cluster</button></header>
            <div className="grid grid-cols-1 gap-8 max-w-5xl">{clusters.map((c: any) => (
                <div key={c.id} className="bg-slate-800 rounded-3xl border border-slate-700 overflow-hidden shadow-sm transition-all hover:border-slate-500">
                  <div className="p-8">
                    <div className="flex justify-between items-center mb-6">
                      <div className="flex items-center gap-4"><div className="p-3 bg-blue-500/10 rounded-2xl text-blue-500"><Cloud size={28} /></div><div><h4 className="font-bold text-2xl">{c.name}</h4><span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">{c.provider} • {c.id.slice(0,8)}</span></div></div>
                      <div className="flex items-center gap-3"><span className={`text-[10px] font-bold px-4 py-1.5 rounded-full uppercase flex items-center gap-2 ${c.status === 'healthy' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500 animate-pulse'}`}><div className={`w-2 h-2 rounded-full ${c.status === 'healthy' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>{c.status}</span><button onClick={() => setShowLogModal({ type: 'cluster', id: c.id })} className="p-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-slate-300 transition-colors"><FileText size={20} /></button><button onClick={() => setConfirmDestroy({ type: 'cluster', id: c.id, name: c.name })} className="p-2.5 bg-slate-700 hover:bg-red-600 rounded-xl text-red-400 hover:text-white transition-all"><Trash2 size={20} /></button></div>
                    </div>
                    <div className="mt-4 pt-6 border-t border-slate-700/50">
                       <button onClick={() => setExpandedCluster(expandedCluster === c.id ? null : c.id)} className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors uppercase tracking-widest">{expandedCluster === c.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Cluster Inspector</button>
                       {expandedCluster === c.id && (
                         <div className="mt-6 space-y-8 animate-in fade-in slide-in-from-top-2 duration-300">
                           <div>
                              <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Layers size={12} className="text-blue-400" /> Helm Chart Inventory</h5>
                              {loadingClusterHelm ? (
                                <div className="text-slate-500 text-xs italic">Scanning Helm repository...</div>
                              ) : clusterHelmReleases?.length > 0 ? (
                                <div className="grid grid-cols-2 gap-4">
                                   {clusterHelmReleases.map((release: any) => (
                                     <div key={release.name} className="bg-slate-900/50 border border-slate-700 p-4 rounded-xl flex justify-between items-center">
                                        <div>
                                          <div className="font-bold text-sm">{release.name}</div>
                                          <div className="text-[10px] text-slate-500">{release.chart} • v{release.app_version}</div>
                                        </div>
                                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase ${release.status === 'deployed' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>{release.status}</span>
                                     </div>
                                   ))}
                                </div>
                              ) : <div className="text-slate-600 text-xs italic">No Helm charts installed.</div>}
                           </div>
                           <div>
                              <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Cpu size={12} className="text-blue-400" /> Infrastructure Node Status</h5>
                              {loadingClusterPods ? (
                                <div className="text-center py-6"><Loader2 className="animate-spin text-slate-600 mx-auto" size={24} /></div>
                              ) : Array.isArray(clusterPods) && clusterPods.length > 0 ? (
                                <div className="bg-slate-900/50 rounded-2xl border border-slate-700/50 overflow-hidden"><table className="w-full text-left text-xs"><thead className="bg-slate-800/50 text-slate-500 uppercase tracking-tighter"><tr><th className="px-6 py-3">Namespace</th><th className="px-6 py-3">Pod Name</th><th className="px-6 py-3">Status</th><th className="px-6 py-3">IP</th><th className="px-6 py-3 text-right">Age</th></tr></thead>
                                    <tbody className="divide-y divide-slate-800">{clusterPods.map((pod: any) => (<tr key={pod?.metadata?.name || Math.random()} className="hover:bg-slate-800/30 transition-colors group"><td className="px-6 py-4 font-mono text-[10px] text-blue-400/80">{pod?.metadata?.namespace || '---'}</td><td className="px-6 py-4 font-bold text-slate-300 group-hover:text-white truncate max-w-[200px]">{pod?.metadata?.name || 'Unknown'}</td><td className="px-6 py-4"><div className="flex items-center gap-2"><div className={`w-1.5 h-1.5 rounded-full ${pod?.status?.phase === 'Running' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-yellow-500 animate-pulse'}`}></div><span className="font-medium text-slate-400">{pod?.status?.phase || 'Pending'}</span></div></td><td className="px-6 py-4 font-mono text-slate-500 text-[10px]">{pod?.status?.podIP || '---'}</td><td className="px-6 py-4 text-right text-slate-600">{pod?.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).toLocaleTimeString() : '---'}</td></tr>))}</tbody></table></div>
                              ) : <div className="text-center py-6 bg-slate-900/30 rounded-2xl border border-dashed border-slate-700 text-slate-500 text-sm">{podError ? 'API Error' : 'No nodes active.'}</div>}
                           </div>
                         </div>
                       )}
                    </div>
                  </div>
                </div>
              ))}</div>
          </section>
        ) : (
          <section>
            <header className="flex justify-between items-center mb-10"><div><h2 className="text-3xl font-bold">Applications</h2><p className="text-slate-400">Deploy ERP instances.</p></div><button onClick={() => { setShowAppModal(true); setWizardStep(1); }} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105"><Plus size={20} /> Deploy App</button></header>
            <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden shadow-sm">
               <table className="w-full text-left">
                 <thead className="bg-slate-700/30 text-slate-400 text-[10px] uppercase tracking-widest font-bold"><tr><th className="px-8 py-4">App</th><th className="px-8 py-4">Cluster</th><th className="px-8 py-4">Strategy</th><th className="px-8 py-4">Status</th><th className="px-8 py-4 text-right">Actions</th></tr></thead>
                 <tbody className="divide-y divide-slate-700">{deployments.map((a: any) => (
                   <tr key={a.id} className="hover:bg-slate-700/10">
                     <td className="px-8 py-5">
                       {a.status === 'running' ? (
                         <a href={a.url} target="_blank" rel="noreferrer" className="group flex items-center gap-2 w-fit">
                           <span className="font-bold text-xl text-blue-400 group-hover:text-blue-300 transition-colors underline decoration-blue-500/30 underline-offset-4">{a.name}</span>
                           <ExternalLink size={16} className="text-slate-600 group-hover:text-blue-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                         </a>
                       ) : (
                         <span className="font-bold text-xl text-slate-500">{a.name}</span>
                       )}
                     </td>
                     <td className="px-8 py-5 text-slate-400">{clusters.find((c:any) => c.id === a.clusterId)?.name || 'Unknown'}</td><td className="px-8 py-5"><span className="text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-slate-500/10 text-slate-400">{a.strategy || 'helm'}</span></td><td className="px-8 py-5"><span className="text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-blue-500/10 text-blue-400">{a.status}</span></td><td className="px-8 py-5 text-right flex justify-end gap-3"><button onClick={() => {setShowLogModal({ type: 'app', id: a.id }); setLogTab('provision');}} className="text-slate-400 hover:text-white flex items-center gap-1.5"><FileText size={16} /> Logs</button><button onClick={() => setConfirmDestroy({ type: 'app', id: a.id, name: a.name })} className="text-red-400 hover:text-red-300 flex items-center gap-1.5"><Trash2 size={16} /> Destroy</button></td></tr>))}</tbody>
               </table>
            </div>
          </section>
        )}
      </main>

      {confirmDestroy && (
        <div className="fixed inset-0 bg-red-950/40 backdrop-blur-md flex items-center justify-center p-6 z-[70]">
           <div className="bg-slate-900 border-2 border-red-500/30 rounded-3xl p-10 w-full max-md shadow-2xl animate-in zoom-in-95 duration-200"><div className="flex justify-center mb-6"><div className="p-4 bg-red-500/10 rounded-full"><AlertTriangle className="text-red-500" size={40} /></div></div><h3 className="text-2xl font-bold text-center mb-2">Confirm Destruction</h3><p className="text-slate-400 text-center text-sm mb-8 leading-relaxed">Are you absolutely sure you want to destroy <strong>{confirmDestroy.name}</strong>?</p><div className="flex gap-4"><button onClick={() => setConfirmDestroy(null)} className="flex-1 bg-slate-800 py-3 rounded-xl font-bold hover:bg-slate-700 transition-all">Cancel</button><button onClick={() => destroyResource.mutate({ type: confirmDestroy.type, id: confirmDestroy.id })} className="flex-1 bg-red-600 py-3 rounded-xl font-bold hover:bg-red-500 shadow-lg transition-all">{destroyResource.isPending ? <Loader2 className="animate-spin" size={18} /> : 'Confirm Delete'}</button></div></div>
        </div>
      )}

      {showLogModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center p-6 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 w-full max-w-6xl h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-300">
            <div className="flex justify-between items-start mb-6">
              <div className="space-y-2 flex-1"><h3 className="text-2xl font-bold flex items-center gap-3"><FileText className="text-blue-500" /> Execution Tracing</h3><div className="flex gap-4 border-b border-slate-700">
                <button onClick={() => setLogTab('provision')} className={`pb-2 px-1 text-sm font-bold transition-all ${logTab === 'provision' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}>Infrastructure</button>
                {showLogModal.type === 'app' && (<>
                  <button onClick={() => setLogTab('helm')} className={`pb-2 px-1 text-sm font-bold transition-all ${logTab === 'helm' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}>Helm Status</button>
                  <button onClick={() => setLogTab('app')} className={`pb-2 px-1 text-sm font-bold transition-all ${logTab === 'app' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}>Pod Inspector</button>
                  <button onClick={() => setLogTab('diagnostics')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1 ${logTab === 'diagnostics' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Activity size={14} /> Diagnostics</button>
                  <button onClick={() => setLogTab('modules')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1 ${logTab === 'modules' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Puzzle size={14} /> Modules</button>
                </>)}
              </div></div>
              <button onClick={() => {setShowLogModal(null); setSelectedPod(null);}} className="text-slate-400 hover:text-white"><X size={24} /></button>
            </div>
            <div className="flex-1 flex gap-6 min-h-0">
               {showLogModal.type === 'app' && logTab === 'app' && (
                 <div className="w-64 bg-slate-900/50 rounded-xl border border-slate-700 p-4 overflow-y-auto">
                    <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Cpu size={12} /> Active Pods</div>
                    <div className="space-y-2">
                       {pods.length > 0 ? pods.map((p: any) => (
                         <button key={p?.metadata?.name || Math.random()} onClick={() => {setSelectedPod(p.metadata.name); setKubeLogs('');}} className={`w-full text-left p-3 rounded-lg text-xs transition-all border ${selectedPod === p?.metadata?.name ? 'bg-blue-600/20 border-blue-500 text-blue-100' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'}`}>
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
               {logTab !== 'modules' && (
                 <div className="flex-1 bg-slate-950 rounded-xl p-6 font-mono text-[11px] overflow-y-auto whitespace-pre-wrap border border-slate-700/50 shadow-inner custom-scrollbar text-blue-100/90 leading-relaxed relative">
                   {logTab === 'provision' ? (socketLogs || 'Loading flow...') : 
                    logTab === 'helm' ? (helmStatus?.content || 'Fetching Helm...') : 
                    logTab === 'diagnostics' ? (diagnostics?.content || 'Scanning cluster for errors...') :
                    (selectedPod ? (kubeLogs || `Connected...`) : 'Select a pod to begin tailing.')}
                   <div ref={logEndRef} />
                 </div>
               )}
            </div>
          </div>
        </div>
      )}

      {showAppModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center mb-8"><h3 className="text-2xl font-bold">Deployment Wizard</h3><div className="flex gap-2">{[1, 2, 3, 4, 5].map(s => (<div key={s} className={`w-8 h-1.5 rounded-full transition-all ${wizardStep >= s ? 'bg-blue-500' : 'bg-slate-700'}`}></div>))}</div></div>
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
              {wizardStep === 1 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Package className="text-blue-500" size={18}/> Target Configuration</h4><p className="text-slate-400 text-sm">Select the infrastructure and deployment name.</p></div>
                  <div><label htmlFor="wizard-instance-name" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Instance Name</label><input id="wizard-instance-name" value={wizardData.name} onChange={e => setWizardData({...wizardData, name: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all" /></div>
                  <div><label htmlFor="wizard-target-cluster" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Target Cluster</label><select id="wizard-target-cluster" value={wizardData.clusterId} onChange={e => setWizardData({...wizardData, clusterId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all"><option value="">Select a healthy cluster...</option>{clusters.filter((c:any) => c.status === 'healthy').map((c: any) => (<option key={c.id} value={c.id}>{c.name} ({c.provider})</option>))}</select></div>
                </div>
              )}
              {wizardStep === 2 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Blocks className="text-blue-400" size={18}/> Deployment Strategy</h4><p className="text-slate-400 text-sm">Choose how the application is orchestrated.</p></div>
                  <div className="grid grid-cols-2 gap-4">
                    <button onClick={() => selectStrategy('helm')} className={`p-6 rounded-2xl border-2 text-left transition-all ${wizardData.strategy === 'helm' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`}>
                      <div className="p-3 bg-blue-500/20 rounded-xl w-fit mb-4"><Layers size={24} className="text-blue-500" /></div>
                      <div className="font-bold text-lg">Helm Chart</div>
                      <div className="text-xs text-slate-400 mt-1">Bitnami-managed stack. Includes advanced features and hardened images.</div>
                    </button>
                    <button onClick={() => selectStrategy('native')} className={`p-6 rounded-2xl border-2 text-left transition-all ${wizardData.strategy === 'native' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`}>
                      <div className="p-3 bg-green-500/20 rounded-xl w-fit mb-4"><Box size={24} className="text-green-500" /></div>
                      <div className="font-bold text-lg">Native K8s</div>
                      <div className="text-xs text-slate-400 mt-1">Raw Kubernetes resources. Uses official library images directly.</div>
                    </button>
                  </div>
                </div>
              )}
              {wizardStep === 3 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Zap className="text-yellow-500" size={18}/> Component: Odoo</h4><p className="text-slate-400 text-sm">Select the image version.</p></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label><input value={wizardData.odooRepo} onChange={e => setWizardData({...wizardData, odooRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" /></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Available Tags</label>{loadingOdooTags ? (<div className="flex items-center gap-2 text-slate-500 py-3"><Loader2 size={16} className="animate-spin" /> Fetching tags...</div>) : (<div className="grid grid-cols-2 gap-2">{odooTags.map((tag: string) => (<button key={tag} onClick={() => setWizardData({...wizardData, odooTag: tag})} className={`px-4 py-2 rounded-lg text-left text-xs border transition-all ${wizardData.odooTag === tag ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>{tag}</button>))}</div>)}</div>
                </div>
              )}
              {wizardStep === 4 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Database className="text-green-500" size={18}/> Component: Database</h4><p className="text-slate-400 text-sm">Select the database version.</p></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label><input value={wizardData.pgRepo} onChange={e => setWizardData({...wizardData, pgRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" /></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Available Tags</label>{loadingPgTags ? (<div className="flex items-center gap-2 text-slate-500 py-3"><Loader2 size={16} className="animate-spin" /> Fetching tags...</div>) : (<div className="grid grid-cols-2 gap-2">{pgTags.map((tag: string) => (<button key={tag} onClick={() => setWizardData({...wizardData, pgTag: tag})} className={`px-4 py-2 rounded-lg text-left text-xs border transition-all ${wizardData.pgTag === tag ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>{tag}</button>))}</div>)}</div>
                </div>
              )}
              {wizardStep === 5 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-8 bg-green-500/5 rounded-3xl border border-green-500/20 text-center"><div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4"><Check className="text-green-500" size={32} /></div><h4 className="text-xl font-bold">Ready to Launch</h4><p className="text-slate-400 text-sm">Confirm the configuration for <strong>{wizardData.name}</strong>.</p></div>
                  <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-700 space-y-4 text-sm">
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>Cluster</span><span className="font-bold text-slate-300">{clusters.find((c:any) => c.id === wizardData.clusterId)?.name}</span></div>
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>Strategy</span><span className="font-bold text-blue-400 uppercase tracking-widest text-[10px]">{wizardData.strategy}</span></div>
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>Odoo</span><span className="font-mono text-xs text-slate-300">{wizardData.odooRepo}:{wizardData.odooTag}</span></div>
                    <div className="flex justify-between"><span>Postgres</span><span className="font-mono text-xs text-slate-300">{wizardData.pgRepo}:{wizardData.pgTag}</span></div>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-10 flex gap-4 pt-8 border-t border-slate-700">{wizardStep > 1 && (<button onClick={prevStep} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2"><ArrowLeft size={18} /> Back</button>)}<div className="flex-1"></div>{wizardStep < 5 ? (<button disabled={(wizardStep === 1 && !wizardData.clusterId)} onClick={nextStep} className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 disabled:opacity-50">Next <ArrowRight size={18} /></button>) : (<button onClick={() => deployApp.mutate(wizardData)} className="px-10 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold">🚀 Initiate Deployment</button>)}</div>
          </div>
        </div>
      )}

      {showClusterModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="text-2xl font-bold mb-8 text-center">Provision New Cluster</h3>
            <form onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); provisionCluster.mutate({ name: d.get('name'), provider: d.get('provider') }); }}>
              <div className="space-y-6">
                <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cluster Identity</label><input name="name" required className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 transition-all text-sm" placeholder="e.g. production-omega" /></div>
                <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cloud Provider</label><select name="provider" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm"><option value="k3d">Local Datacenter (k3d)</option><option value="aws">Amazon Web Services (EKS)</option><option value="gcp">Google Cloud Platform (GKE)</option></select></div>
              </div>
              <div className="flex gap-4 mt-10"><button type="button" onClick={() => setShowClusterModal(false)} className="flex-1 bg-slate-700 py-3 rounded-xl font-bold hover:bg-slate-600 transition-all text-sm">Cancel</button><button type="submit" className="flex-1 bg-blue-600 py-3 rounded-xl font-bold shadow-lg shadow-blue-900/20 hover:bg-blue-500 transition-all text-sm">Start Provisioning</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
