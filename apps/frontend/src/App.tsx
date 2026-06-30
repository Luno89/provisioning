import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Layout, Server, Plus, Cloud, Terminal, FileText, X, Trash2, Zap, Cpu, Loader2, AlertTriangle, BellRing, ChevronDown, ChevronUp, Check, ArrowRight, ArrowLeft, Package, Database, Layers, Activity, Box, Blocks, ExternalLink, Puzzle, HardDrive, Shield, Timer } from 'lucide-react';
import TemporalPanel from './TemporalPanel.js';

const API_BASE = (import.meta.env?.VITE_API_BASE as string) || 'http://localhost:3001/api';
const SOCKET_URL = (import.meta.env?.VITE_SOCKET_URL as string) || 'http://localhost:3001';

const APP_DEFAULTS: Record<string, {
  helm: { webRepo: string; webTag: string; dbRepo: string; dbTag: string };
  native: { webRepo: string; webTag: string; dbRepo: string; dbTag: string };
  hasDatabase: boolean;
  strategies: ('helm' | 'native')[];
}> = {
  odoo: {
    helm: { webRepo: 'bitnamilegacy/odoo', webTag: '18.0.20250805-debian-12-r8', dbRepo: 'bitnamilegacy/postgresql', dbTag: '17.5.0-debian-12-r20' },
    native: { webRepo: 'library/odoo', webTag: '18.0', dbRepo: 'library/postgres', dbTag: '16.4' },
    hasDatabase: true,
    strategies: ['native']
  },
  wordpress: {
    helm: { webRepo: 'bitnamilegacy/wordpress', webTag: '6.7.1-debian-12-r3', dbRepo: 'bitnamilegacy/mariadb', dbTag: '11.4.5-debian-12-r3' },
    native: { webRepo: 'library/wordpress', webTag: '6.7-apache', dbRepo: 'library/mariadb', dbTag: '11.4' },
    hasDatabase: true,
    strategies: ['helm', 'native']
  },
  nextcloud: {
    helm: { webRepo: 'bitnamilegacy/nextcloud', webTag: '30.0.5-debian-12-r1', dbRepo: 'bitnamilegacy/mariadb', dbTag: '11.4.5-debian-12-r3' },
    native: { webRepo: 'library/nextcloud', webTag: '30.0-apache', dbRepo: 'library/mariadb', dbTag: '11.4' },
    hasDatabase: true,
    strategies: ['helm', 'native']
  },
  audiobookshelf: {
    helm: { webRepo: 'advplyr/audiobookshelf', webTag: '2.19.0', dbRepo: '', dbTag: '' },
    native: { webRepo: 'advplyr/audiobookshelf', webTag: '2.19.0', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['helm', 'native']
  },
  prometheus: {
    helm: { webRepo: 'prometheus/prometheus', webTag: 'v3.1.0', dbRepo: '', dbTag: '' },
    native: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['helm']
  },
  traefik: {
    helm: { webRepo: 'traefik', webTag: 'v3.6.0', dbRepo: '', dbTag: '' },
    native: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['helm']
  }
};

function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'clusters' | 'apps' | 'nginx' | 'temporal'>('clusters');
  const [editorContent, setEditorContent] = useState('');
  const [showClusterModal, setShowClusterModal] = useState(false);
  const [showAppModal, setShowAppModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState<{ type: 'cluster' | 'app', id: string } | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState<{ type: 'cluster' | 'app', id: string, name: string } | null>(null);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<any[]>([]);
  
  const [logTab, setLogTab] = useState<'general' | 'provision' | 'helm' | 'app' | 'diagnostics' | 'modules' | 'storage'>('general');
  const [storageInputs, setStorageInputs] = useState<Record<string, string>>({});
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [socketLogs, setSocketLogs] = useState<string>('');
  const [kubeLogs, setKubeLogs] = useState<string>('');
  const logEndRef = useRef<HTMLDivElement>(null);
  const [vpnDomains, setVpnDomains] = useState<Record<string, string>>({});
  const [showNginxWizard, setShowNginxWizard] = useState(false);
  const [nginxWizardStep, setNginxWizardStep] = useState(1);
  const [nginxWizardData, setNginxWizardData] = useState({
    deploymentId: '',
    domain: '',
    maxBodySize: '10G',
  });

  // Unified Wizard State
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState({
    name: 'Odoo-Production',
    clusterId: '',
    appType: 'odoo' as 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik',
    strategy: 'native' as 'helm' | 'native',
    odooRepo: 'library/odoo',
    odooTag: '18.0',
    pgRepo: 'library/postgres',
    pgTag: '16.4',
    modules: [] as string[],
    vpnEnabled: false,
    vpnProtocol: 'wireguard' as 'wireguard' | 'openvpn',
    vpnConfig: '',
    vpnDedicatedIp: ''
  });

  const { data: clusters = [] } = useQuery({ queryKey: ['clusters'], queryFn: () => axios.get(`${API_BASE}/clusters`).then(res => res.data), refetchInterval: 3000 });
  const { data: deployments = [] } = useQuery({ queryKey: ['deployments'], queryFn: () => axios.get(`${API_BASE}/deployments`).then(res => res.data), refetchInterval: 3000 });
  
  const currentDeployment = showLogModal?.type === 'app' ? deployments.find((d: any) => d.id === showLogModal.id) : null;

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
  const { data: availableModules = [], isLoading: loadingModules } = useQuery({
    queryKey: ['modules', currentDeployment?.appType],
    queryFn: () => axios.get(`${API_BASE}/modules?appType=${currentDeployment?.appType || 'odoo'}`).then(res => res.data),
    enabled: !!showLogModal && logTab === 'modules' && !!currentDeployment
  });

  const { data: odooTags = [], isLoading: loadingOdooTags } = useQuery({ queryKey: ['tags', wizardData.odooRepo], queryFn: () => axios.get(`${API_BASE}/registry/tags?repo=${wizardData.odooRepo}`).then(res => res.data), enabled: showAppModal && wizardStep === 4 });
  const { data: pgTags = [], isLoading: loadingPgTags } = useQuery({ queryKey: ['tags', wizardData.pgRepo], queryFn: () => axios.get(`${API_BASE}/registry/tags?repo=${wizardData.pgRepo}`).then(res => res.data), enabled: showAppModal && wizardStep === 5 });

  const { data: initialLogs } = useQuery({ 
    queryKey: ['logs', showLogModal?.type, showLogModal?.id], 
    queryFn: () => axios.get(`${API_BASE}/logs/${showLogModal?.type}/${showLogModal?.id}`).then(res => res.data), 
    enabled: !!showLogModal && (logTab === 'provision' || (showLogModal.type === 'app' && currentDeployment?.status === 'failed' && logTab === 'general')) 
  });


  useEffect(() => {
    const socket = io(SOCKET_URL);
    socket.on('resource-destroyed', (data) => {
        const nid = Date.now();
        setNotifications(prev => [...prev, { ...data, nid }]);

        // Safely close modals/expand panels if the active resource was destroyed
        setShowLogModal(current => (current && current.id === data.id) ? null : current);
        setConfirmDestroy(current => (current && current.id === data.id) ? null : current);
        setExpandedCluster(current => (current === data.id) ? null : current);

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

  const getSupportedVolumes = (appType: string, strategy: string): string[] => {
    switch (appType) {
      case 'odoo':
      case 'wordpress':
      case 'nextcloud':
        return strategy === 'helm' ? ['db', 'web'] : ['db'];
      case 'audiobookshelf':
        return ['library', 'metadata', 'config'];
      case 'prometheus':
        return strategy === 'helm' ? ['server'] : [];
      default:
        return [];
    }
  };

  const getFallbackSize = (volume: string): string => {
    switch (volume) {
      case 'library':
        return '5Gi';
      case 'metadata':
        return '2Gi';
      case 'config':
        return '1Gi';
      case 'db':
        return '2Gi';
      case 'web':
        return '5Gi';
      case 'server':
        return '10Gi';
      default:
        return '2Gi';
    }
  };

  const getVolumeDescription = (volume: string): string => {
    switch (volume) {
      case 'db':
        return 'Persistent storage for database engines (PostgreSQL, MariaDB, MySQL).';
      case 'web':
        return 'Persistent storage for web assets and public uploads.';
      case 'library':
        return 'Primary media and audiobook library storage, mounted at /audiobooks.';
      case 'metadata':
        return 'Application metadata and cache database storage, mounted at /metadata.';
      case 'config':
        return 'Configuration files and server settings, mounted at /config.';
      case 'server':
        return 'Prometheus metric storage and TSDB records.';
      default:
        return 'Persistent storage volume.';
    }
  };

  useEffect(() => {
    if (currentDeployment && logTab === 'storage') {
      const supported = getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy);
      const initial: Record<string, string> = {};
      supported.forEach((vol: string) => {
        initial[vol] = currentDeployment.storage?.[vol] || getFallbackSize(vol);
      });
      setStorageInputs(initial);
    }
  }, [currentDeployment?.id, logTab]);

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

  const updateAppStorage = useMutation({
    mutationFn: ({ id, storage }: any) => axios.patch(`${API_BASE}/deployments/${id}/storage`, { storage }),
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

  const exposeApp = useMutation({
    mutationFn: (id: string) => axios.post(`${API_BASE}/deployments/${id}/expose`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    }
  });

  const unexposeApp = useMutation({
    mutationFn: (id: string) => axios.post(`${API_BASE}/deployments/${id}/unexpose`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    }
  });

  const { data: nginxConfig, isLoading: loadingNginxConfig } = useQuery({
    queryKey: ['nginx-config'],
    queryFn: () => axios.get(`${API_BASE}/nginx/config`).then(res => res.data),
    enabled: view === 'nginx'
  });

  const updateNginxConfig = useMutation({
    mutationFn: (newContent: string) => axios.post(`${API_BASE}/nginx/config`, { content: newContent }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nginx-config'] });
    }
  });

  useEffect(() => {
    if (nginxConfig?.content !== undefined) {
      setEditorContent(nginxConfig.content);
    }
  }, [nginxConfig]);

  const nextStep = () => {
    const config = APP_DEFAULTS[wizardData.appType];
    if (wizardStep === 2) {
      if (wizardData.strategy === 'native') {
        setWizardStep(3);
      } else {
        setWizardStep(4);
      }
    } else if (wizardStep === 3) {
      setWizardStep(4);
    } else if (wizardStep === 4 && !config.hasDatabase) {
      setWizardStep(6);
    } else {
      setWizardStep(s => s + 1);
    }
  };

  const prevStep = () => {
    const config = APP_DEFAULTS[wizardData.appType];
    if (wizardStep === 4) {
      if (wizardData.strategy === 'native') {
        setWizardStep(3);
      } else {
        setWizardStep(2);
      }
    } else if (wizardStep === 3) {
      setWizardStep(2);
    } else if (wizardStep === 6 && !config.hasDatabase) {
      setWizardStep(4);
    } else {
      setWizardStep(s => s - 1);
    }
  };

  const handleAppTypeChange = (newAppType: 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik') => {
    const config = APP_DEFAULTS[newAppType];
    const newStrategy = config.strategies.includes(wizardData.strategy) ? wizardData.strategy : config.strategies[0];
    const defaults = config[newStrategy];
    const capitalized = newAppType.charAt(0).toUpperCase() + newAppType.slice(1);
    
    setWizardData(prev => {
      const prevCapitalized = prev.appType.charAt(0).toUpperCase() + prev.appType.slice(1);
      const isDefaultName = prev.name === `${prevCapitalized}-Production`;
      return {
        ...prev,
        appType: newAppType,
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
    const config = APP_DEFAULTS[appType];
    if (!config.strategies.includes(strat)) return;
    
    const defaults = config[strat];
    setWizardData(prev => ({
      ...prev,
      strategy: strat,
      odooRepo: defaults.webRepo,
      odooTag: defaults.webTag,
      pgRepo: defaults.dbRepo,
      pgTag: defaults.dbTag
    }));
  };

  const openDashboard = (type: 'cluster' | 'app', id: string) => {
    setShowLogModal({ type, id });
    setLogTab(type === 'app' ? 'general' : 'provision');
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex font-sans overflow-hidden">
      <aside className="w-64 bg-slate-800 border-r border-slate-700 p-6 flex flex-col shadow-xl z-20">
        <div className="flex items-center gap-2 mb-10"><Layout className="text-blue-500" /><h1 className="text-xl font-bold tracking-tight">Provisioner v2</h1></div>
        <nav className="space-y-2 flex-1">
          <button onClick={() => setView('clusters')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'clusters' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}><Cloud size={20} /> Clusters</button>
          <button onClick={() => setView('apps')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'apps' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}><Server size={20} /> Applications</button>
          <button onClick={() => setView('nginx')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'nginx' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}><Puzzle size={20} /> Nginx Router</button>
          <button onClick={() => setView('temporal')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'temporal' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}><Timer size={20} /> Temporal</button>
        </nav>
        <div className="pt-6 border-t border-slate-700 flex items-center gap-3 text-slate-500 text-[10px] uppercase font-black tracking-widest"><Terminal size={14} /> <span>Local Ops Active</span></div>
      </aside>

      <main className="flex-1 p-10 overflow-y-auto relative">
        <div className="fixed top-6 right-6 z-[60] space-y-3">
          {notifications.map(n => (<div key={n.nid} className={`bg-slate-800 border-l-4 ${n.outOfBand ? 'border-yellow-500' : 'border-green-500'} p-4 rounded-lg shadow-2xl flex items-center gap-4 min-w-[300px] animate-in slide-in-from-right`}><BellRing className={n.outOfBand ? 'text-yellow-500' : 'text-green-500'} size={20} /><div><div className="text-[10px] font-black uppercase text-slate-500 tracking-tighter">{n.outOfBand ? 'External Event' : 'System Event'}</div><div className="text-sm font-bold">{n.name} {n.outOfBand ? 'Deleted Externally' : 'Destroyed'}</div></div></div>))}
        </div>

        {view === 'clusters' && (
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
        )}

        {view === 'apps' && (
          <section>
            <header className="flex justify-between items-center mb-10"><div><h2 className="text-3xl font-bold">Applications</h2><p className="text-slate-400">Deploy application instances.</p></div><button onClick={() => { setShowAppModal(true); setWizardStep(1); setWizardData({ name: 'Odoo-Production', clusterId: '', appType: 'odoo', strategy: 'native', odooRepo: 'library/odoo', odooTag: '18.0', pgRepo: 'library/postgres', pgTag: '16.4', modules: [], vpnEnabled: false, vpnProtocol: 'wireguard', vpnConfig: '', vpnDedicatedIp: '' }); }} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105"><Plus size={20} /> Deploy App</button></header>
            <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden shadow-sm">
               <table className="w-full text-left">
                  <thead className="bg-slate-700/30 text-slate-400 text-[10px] uppercase tracking-widest font-bold"><tr><th className="px-8 py-4">App</th><th className="px-8 py-4">Cluster</th><th className="px-8 py-4">Strategy</th><th className="px-8 py-4">Status</th><th className="px-8 py-4 text-right">Actions</th></tr></thead>
                  <tbody className="divide-y divide-slate-700">{deployments.map((a: any) => (
                    <tr key={a.id} className="hover:bg-slate-700/10">
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] px-2.5 py-1 rounded-md font-bold uppercase tracking-wider bg-slate-900 border border-slate-700 text-slate-300">
                            {a.appType || 'odoo'}
                          </span>
                          <div className="flex flex-col gap-1">
                            {a.status === 'running' ? (
                              <a href={a.url} target="_blank" rel="noreferrer" className="group flex items-center gap-2 w-fit">
                                <span className="font-bold text-xl text-blue-400 group-hover:text-blue-300 transition-colors underline decoration-blue-500/30 underline-offset-4">{a.name}</span>
                                <ExternalLink size={16} className="text-slate-600 group-hover:text-blue-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                              </a>
                            ) : (
                              <span className="font-bold text-xl text-slate-500">{a.name}</span>
                            )}
                            {a.isExposed && a.exposureUrl && (
                              <a href={a.exposureUrl} target="_blank" rel="noreferrer" className="group flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors w-fit font-semibold mt-1">
                                <span>Exposed: {a.exposureUrl}</span>
                                <ExternalLink size={12} className="opacity-60 group-hover:opacity-100 transition-opacity" />
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-slate-400">{clusters.find((c:any) => c.id === a.clusterId)?.name || 'Unknown'}</td><td className="px-8 py-5"><div className="flex flex-col gap-1.5 items-start"><span className="text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-slate-500/10 text-slate-400">{a.strategy || 'helm'}</span>{a.vpnEnabled && (<span className="text-[9px] px-2.5 py-0.5 rounded-md font-bold uppercase tracking-wider bg-green-500/10 text-green-400 border border-green-500/20 flex items-center gap-1"><Shield size={10} /> VPN</span>)}</div></td><td className="px-8 py-5"><span className="text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-blue-500/10 text-blue-400">{a.status}</span></td>
                      <td className="px-8 py-5 text-right flex justify-end items-center gap-3">
                        <button onClick={() => openDashboard('app', a.id)} className="px-4 py-2 bg-blue-600/10 hover:bg-blue-600 border border-blue-500/30 text-blue-400 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"><Activity size={14} /> Manage</button>
                        <button onClick={() => setConfirmDestroy({ type: 'app', id: a.id, name: a.name })} className="px-4 py-2 bg-slate-700/50 hover:bg-red-600 border border-slate-600 hover:border-red-500 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"><Trash2 size={14} /> Destroy</button>
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>
           </section>
        )}

        {view === 'nginx' && (
          <section className="animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-5xl">
            <header className="flex justify-between items-center mb-10">
              <div>
                <h2 className="text-3xl font-bold">Nginx Router Settings</h2>
                <p className="text-slate-400">Configure global ingress limits, custom proxy settings, and HTTP configurations.</p>
              </div>
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => { setShowNginxWizard(true); setNginxWizardStep(1); setNginxWizardData({ deploymentId: '', domain: '', maxBodySize: '10G' }); }}
                  className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-5 py-2.5 rounded-xl flex items-center gap-2 font-semibold shadow-md transition-all cursor-pointer"
                >
                  <Shield size={18} /> Proxy Wizard
                </button>
                <button
                  disabled={loadingNginxConfig || updateNginxConfig.isPending}
                  onClick={() => updateNginxConfig.mutate(editorContent)}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl flex items-center gap-2 font-bold shadow-lg disabled:opacity-50 transition-all hover:scale-105 animate-all cursor-pointer"
                >
                  {updateNginxConfig.isPending ? (
                    <Loader2 className="animate-spin" size={18} />
                  ) : (
                    <Check size={18} />
                  )}
                  Save & Reload Nginx
                </button>
              </div>
            </header>
            
            {updateNginxConfig.isSuccess && (
              <div className="mb-6 p-4 bg-green-500/10 border border-green-500/20 text-green-400 rounded-xl text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95">
                <Check size={16} /> Nginx configuration saved and reloaded successfully!
              </div>
            )}
            {updateNginxConfig.isError && (
              <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95">
                <AlertTriangle size={16} /> {(updateNginxConfig.error as any)?.response?.data?.error || updateNginxConfig.error.message}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-4">
                <div className="bg-slate-950 rounded-2xl border border-slate-800 p-6 shadow-inner relative flex flex-col h-[65vh]">
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">nginx.conf Editor</span>
                    <span className="text-[9px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">etc/nginx/nginx.conf</span>
                  </div>
                  {loadingNginxConfig ? (
                    <div className="flex-1 flex items-center justify-center">
                      <Loader2 className="animate-spin text-blue-500" size={32} />
                    </div>
                  ) : (
                    <textarea
                      value={editorContent}
                      onChange={(e) => setEditorContent(e.target.value)}
                      className="flex-1 bg-transparent border-0 focus:ring-0 focus:outline-none p-0 font-mono text-xs text-slate-300 leading-relaxed resize-none custom-scrollbar"
                      placeholder="Loading configuration..."
                      rows={25}
                    />
                  )}
                </div>
              </div>

              <div className="space-y-6">
                <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm">
                  <h4 className="font-bold flex items-center gap-2 text-sm text-slate-200 mb-4"><Shield className="text-blue-500" size={16} /> VPN Domain Routing Helper</h4>
                  <p className="text-slate-400 text-xs mb-4 leading-relaxed">
                    Generate Nginx reverse-proxy server blocks to route traffic from a dedicated VPN IP to your cluster's applications.
                  </p>
                  
                  {deployments.length === 0 ? (
                    <div className="text-xs italic text-slate-500 py-3 text-center">
                      No active deployments found. Deploy an app first.
                    </div>
                  ) : (
                    <div className="space-y-4 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
                      {deployments.map((d: any) => {
                        const cluster = clusters.find((c: any) => c.id === d.clusterId);
                        const clusterName = cluster ? cluster.name : 'unknown';
                        const ns = d.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
                        
                        // Determine service name and port based on appType
                        const serviceName = d.appType === 'prometheus' ? 'prometheus-server' : d.appType || 'odoo';
                        const port = d.appType === 'odoo' ? '8069' : '80';
                        const internalDns = `http://${serviceName}.${ns}.svc.cluster.local:${port}`;
                        
                        const domainKey = `${d.id}`;
                        const currentDomain = vpnDomains[domainKey] || `${d.name.toLowerCase()}.vpn.local`;
                        
                        const nginxBlock = `
    # Proxy configuration for ${d.name} (${d.appType}) on cluster ${clusterName}
    server {
        listen 80;
        server_name ${currentDomain};

        location / {
            proxy_pass ${internalDns};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }`;

                        const handleInsert = () => {
                          if (editorContent.includes('http {')) {
                            const lastBraceIdx = editorContent.lastIndexOf('}');
                            if (lastBraceIdx !== -1) {
                              const newContent = editorContent.slice(0, lastBraceIdx) + nginxBlock + '\n' + editorContent.slice(lastBraceIdx);
                              setEditorContent(newContent);
                              return;
                            }
                          }
                          setEditorContent(prev => prev + '\n' + nginxBlock);
                        };

                        return (
                          <div key={d.id} className="p-4 bg-slate-900/60 border border-slate-700/60 rounded-xl space-y-3">
                            <div className="flex justify-between items-center">
                              <span className="font-bold text-slate-200 text-xs">{d.name}</span>
                              <span className="text-[9px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono font-bold uppercase">{d.appType || 'odoo'}</span>
                            </div>
                            <div className="text-[10px] text-slate-400 space-y-1">
                              <div><span className="text-slate-500">Cluster:</span> <span className="font-mono text-slate-300">{clusterName}</span></div>
                              <div><span className="text-slate-500">Namespace:</span> <span className="font-mono text-slate-300">{ns}</span></div>
                              <div><span className="text-slate-500">Internal DNS:</span> <span className="font-mono text-[9px] text-slate-300">{internalDns}</span></div>
                            </div>
                            <div>
                              <label className="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Proxy Hostname</label>
                              <input 
                                type="text"
                                value={currentDomain}
                                onChange={e => setVpnDomains(prev => ({ ...prev, [domainKey]: e.target.value }))}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-300 focus:border-blue-500 transition-all font-mono"
                                placeholder="e.g. app.vpn.local"
                              />
                            </div>
                            <div className="flex gap-2 pt-1">
                              <button 
                                onClick={handleInsert}
                                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-1.5 px-3 rounded-lg text-[10px] transition-all flex items-center justify-center gap-1 cursor-pointer"
                              >
                                <Plus size={12} /> Inject config
                              </button>
                              <button 
                                onClick={() => {
                                  navigator.clipboard.writeText(nginxBlock);
                                }}
                                className="bg-slate-700 hover:bg-slate-600 text-slate-300 font-bold py-1.5 px-3 rounded-lg text-[10px] transition-all cursor-pointer"
                              >
                                Copy
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm">
                  <h4 className="font-bold flex items-center gap-2 text-sm text-slate-200 mb-4"><Puzzle className="text-blue-500" size={16} /> Configuration Hints</h4>
                  <div className="space-y-4 text-xs text-slate-400 leading-relaxed">
                    <p>To configure file upload limits (e.g. for WordPress or Odoo ERP), add the following line inside the <code className="bg-slate-900 px-1.5 py-0.5 rounded text-blue-400 font-mono">http &#123; ... &#125;</code> block:</p>
                    <pre className="bg-slate-950 p-3 rounded-lg font-mono text-[11px] text-slate-300 border border-slate-800/60 leading-normal">client_max_body_size 10G;</pre>
                    <p>This allows transfers of large database dumps, media, and system files without causing "413 Request Entity Too Large" errors.</p>
                  </div>
                </div>
                
                <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm">
                  <h4 className="font-bold flex items-center gap-2 text-sm text-slate-200 mb-4"><Terminal className="text-blue-500" size={16} /> Container Status</h4>
                  <div className="space-y-3 text-xs text-slate-400">
                    <div className="flex justify-between items-center">
                      <span>Proxy Service</span>
                      <span className="font-bold text-green-400 bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 text-[10px] uppercase">Active</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Host Port</span>
                      <span className="font-mono text-slate-300">80</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Tunnel Port</span>
                      <span className="font-mono text-slate-300">8000</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
        {view === 'temporal' && <TemporalPanel />}
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
                      <button onClick={() => setLogTab('storage')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'storage' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><HardDrive size={14} /> Storage</button>
                    </>
                  ) : (
                    <button onClick={() => setLogTab('provision')} className={`pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'provision' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}><Terminal size={14} /> Infrastructure</button>
                  )}
                </div>
              </div>
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
               {logTab === 'storage' && currentDeployment && (
                  <div className="flex-1 flex flex-col min-h-0">
                     <div className="flex justify-between items-center mb-6">
                         <div>
                           <h4 className="text-xl font-bold">Storage Volumes Management</h4>
                           <p className="text-slate-400 text-xs">Resize persistent disk volumes allocated to this instance.</p>
                         </div>
                         <button 
                           disabled={updateAppStorage.isPending || getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy).length === 0} 
                           onClick={() => updateAppStorage.mutate({ id: currentDeployment.id, storage: storageInputs })} 
                           className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
                         >
                           {updateAppStorage.isPending ? <Loader2 size={16} className="animate-spin" /> : <><Check size={16} /> Apply Changes</>}
                         </button>
                     </div>
                     {getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy).length === 0 ? (
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
                          {getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy).map((vol: string) => {
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
                                     Current: {currentVal}
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
                )}
               {logTab === 'general' && currentDeployment && (
                 <div className="flex-1 flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar">
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
                         <div className={`w-2.5 h-2.5 rounded-full ${currentDeployment.status === 'running' ? 'bg-green-500' : currentDeployment.status === 'deploying' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`}></div>
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

                   <div className="bg-gradient-to-r from-blue-950/30 to-indigo-950/30 border border-blue-500/20 rounded-2xl p-8 flex flex-col gap-6">
                     <div>
                       <h4 className="text-xl font-bold mb-2 flex items-center gap-2"><Zap className="text-blue-400" size={20} /> Network Exposure</h4>
                       <p className="text-slate-400 text-sm leading-relaxed max-w-2xl">
                         Expose this application to the public network interfaces using our dynamic Nginx reverse proxy. This integrates container network routing, allowing external network access.
                       </p>
                     </div>

                     <div className="flex flex-col gap-4 pt-4 border-t border-slate-800/80">
                       <div className="flex items-center gap-4">
                         {currentDeployment.status === 'running' ? (
                           <button
                             disabled={exposeApp.isPending || unexposeApp.isPending}
                             onClick={() => currentDeployment.isExposed ? unexposeApp.mutate(currentDeployment.id) : exposeApp.mutate(currentDeployment.id)}
                             className={`px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all ${currentDeployment.isExposed ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20'}`}
                           >
                             {(exposeApp.isPending || unexposeApp.isPending) ? (
                               <Loader2 size={18} className="animate-spin" />
                             ) : currentDeployment.isExposed ? (
                               <X size={18} />
                             ) : (
                               <Check size={18} />
                             )}
                             {currentDeployment.isExposed ? 'Unexpose Application' : 'Expose Application'}
                           </button>
                         ) : (
                           <div className="text-sm font-semibold text-yellow-500 bg-yellow-500/10 px-4 py-2.5 rounded-lg border border-yellow-500/20 flex items-center gap-2">
                             <AlertTriangle size={16} /> Exposure controls are only available when the deployment is running.
                           </div>
                         )}
                       </div>

                       {currentDeployment.isExposed && currentDeployment.exposureUrl && (
                         <div className="mt-4 p-5 bg-slate-900/80 border border-slate-700 rounded-xl flex items-center justify-between">
                           <div>
                             <div className="text-[10px] font-black uppercase text-green-500 tracking-wider mb-1">Public Access URL</div>
                             <a href={currentDeployment.exposureUrl} target="_blank" rel="noreferrer" className="group flex items-center gap-1.5 text-base font-bold text-blue-400 hover:text-blue-300 transition-colors">
                               <span>{currentDeployment.exposureUrl}</span>
                               <ExternalLink size={16} className="opacity-70 group-hover:opacity-100 transition-opacity" />
                             </a>
                           </div>
                           <span className="text-xs font-semibold px-3 py-1 rounded bg-green-500/10 text-green-400 border border-green-500/20">Active</span>
                         </div>
                       )}
                     </div>
                   </div>
                 </div>
               )}
               {logTab !== 'modules' && logTab !== 'general' && logTab !== 'storage' && (
                 <div className="flex-1 bg-slate-950 rounded-xl p-6 font-mono text-[11px] overflow-y-auto whitespace-pre-wrap border border-slate-700/50 shadow-inner custom-scrollbar text-blue-100/90 leading-relaxed relative">
                    {logTab === 'provision' ? (((initialLogs?.content || '') + socketLogs) || 'Loading flow...') :
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
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Deployment Wizard</h3>
              <div className="flex items-center gap-4">
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5, 6].map(s => {
                    const config = APP_DEFAULTS[wizardData.appType];
                    if (s === 3 && wizardData.strategy !== 'native') return null;
                    if (s === 5 && !config.hasDatabase) return null;
                    return (
                      <div key={s} className={`w-8 h-1.5 rounded-full transition-all ${wizardStep >= s ? 'bg-blue-500' : 'bg-slate-700'}`}></div>
                    );
                  })}
                </div>
                <button onClick={() => setShowAppModal(false)} className="text-slate-400 hover:text-white transition-colors" aria-label="Close Wizard">
                  <X size={24} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
              {wizardStep === 1 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Package className="text-blue-500" size={18}/> Target Configuration</h4><p className="text-slate-400 text-sm">Select the infrastructure, name, and application type.</p></div>
                  <div><label htmlFor="wizard-instance-name" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Instance Name</label><input id="wizard-instance-name" value={wizardData.name} onChange={e => setWizardData({...wizardData, name: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all" /></div>
                  <div><label htmlFor="wizard-target-cluster" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Target Cluster</label><select id="wizard-target-cluster" value={wizardData.clusterId} onChange={e => setWizardData({...wizardData, clusterId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all"><option value="">Select a healthy cluster...</option>{clusters.filter((c:any) => c.status === 'healthy').map((c: any) => (<option key={c.id} value={c.id}>{c.name} ({c.provider})</option>))}</select></div>
                  <div>
                    <label htmlFor="wizard-app-type" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Application Type</label>
                    <select
                      id="wizard-app-type"
                      value={wizardData.appType}
                      onChange={e => handleAppTypeChange(e.target.value as any)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100"
                    >
                      <option value="odoo">Odoo ERP</option>
                      <option value="wordpress">WordPress CMS</option>
                      <option value="nextcloud">Nextcloud Cloud Storage</option>
                      <option value="audiobookshelf">Audiobookshelf Media Server</option>
                      <option value="prometheus">Prometheus Monitoring Stack</option>
                      <option value="traefik">Traefik Ingress Router</option>
                    </select>
                  </div>
                </div>
              )}
              {wizardStep === 2 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Blocks className="text-blue-400" size={18}/> Deployment Strategy</h4><p className="text-slate-400 text-sm">Choose how the application is orchestrated.</p></div>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      disabled={!APP_DEFAULTS[wizardData.appType].strategies.includes('helm')}
                      onClick={() => selectStrategy('helm')}
                      className={`p-6 rounded-2xl border-2 text-left transition-all relative ${!APP_DEFAULTS[wizardData.appType].strategies.includes('helm') ? 'opacity-40 cursor-not-allowed border-slate-800 bg-slate-900' : wizardData.strategy === 'helm' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`}
                    >
                      <div className="p-3 bg-blue-500/20 rounded-xl w-fit mb-4"><Layers size={24} className="text-blue-500" /></div>
                      <div className="font-bold text-lg">Helm Chart</div>
                      <div className="text-xs text-slate-400 mt-1">Bitnami-managed stack. Includes advanced features and hardened images.</div>
                      {!APP_DEFAULTS[wizardData.appType].strategies.includes('helm') && (
                        <span className="absolute top-4 right-4 text-[9px] font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 uppercase">Not Supported</span>
                      )}
                    </button>
                    <button
                      disabled={!APP_DEFAULTS[wizardData.appType].strategies.includes('native')}
                      onClick={() => selectStrategy('native')}
                      className={`p-6 rounded-2xl border-2 text-left transition-all relative ${!APP_DEFAULTS[wizardData.appType].strategies.includes('native') ? 'opacity-40 cursor-not-allowed border-slate-800 bg-slate-900' : wizardData.strategy === 'native' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`}
                    >
                      <div className="p-3 bg-green-500/20 rounded-xl w-fit mb-4"><Box size={24} className="text-green-500" /></div>
                      <div className="font-bold text-lg">Native K8s</div>
                      <div className="text-xs text-slate-400 mt-1">Raw Kubernetes resources. Uses official library images directly.</div>
                      {!APP_DEFAULTS[wizardData.appType].strategies.includes('native') && (
                        <span className="absolute top-4 right-4 text-[9px] font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 uppercase">Not Supported</span>
                      )}
                    </button>
                  </div>
                </div>
              )}
              {wizardStep === 3 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                    <h4 className="font-bold flex items-center gap-2 mb-2"><Shield className="text-blue-500" size={18}/> Windscribe VPN Routing</h4>
                    <p className="text-slate-400 text-sm">Secure and route this individual app instance through a dedicated VPN IP address.</p>
                  </div>
                  
                  <div className="flex items-center justify-between p-4 bg-slate-900/60 border border-slate-700 rounded-2xl">
                    <div>
                      <div className="font-bold text-sm text-slate-200">Enable VPN Tunnel</div>
                      <div className="text-xs text-slate-400 mt-0.5">Route container traffic through a Windscribe secure tunnel.</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setWizardData(prev => ({ ...prev, vpnEnabled: !prev.vpnEnabled }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${wizardData.vpnEnabled ? 'bg-blue-600' : 'bg-slate-700'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${wizardData.vpnEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  {wizardData.vpnEnabled && (
                    <div className="space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">
                      <div>
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">VPN Tunneling Protocol</label>
                        <div className="grid grid-cols-2 gap-4">
                          <button
                            type="button"
                            onClick={() => setWizardData(prev => ({ ...prev, vpnProtocol: 'wireguard' }))}
                            className={`p-4 rounded-xl border text-center transition-all ${wizardData.vpnProtocol === 'wireguard' ? 'border-blue-500 bg-blue-500/10 text-white font-semibold' : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500'}`}
                          >
                            WireGuard (Fastest)
                          </button>
                          <button
                            type="button"
                            onClick={() => setWizardData(prev => ({ ...prev, vpnProtocol: 'openvpn' }))}
                            className={`p-4 rounded-xl border text-center transition-all ${wizardData.vpnProtocol === 'openvpn' ? 'border-blue-500 bg-blue-500/10 text-white font-semibold' : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500'}`}
                          >
                            OpenVPN
                          </button>
                        </div>
                      </div>

                      <div>
                        <label htmlFor="vpn-dedicated-ip" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Dedicated IP / Static IP</label>
                        <input
                          id="vpn-dedicated-ip"
                          type="text"
                          value={wizardData.vpnDedicatedIp}
                          onChange={e => setWizardData(prev => ({ ...prev, vpnDedicatedIp: e.target.value }))}
                          placeholder="e.g. 104.244.72.115"
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3.5 text-sm focus:border-blue-500 focus:outline-none transition-all placeholder:text-slate-600 text-slate-200"
                        />
                      </div>

                      <div>
                        <label htmlFor="vpn-config" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">VPN Configuration File Content</label>
                        <textarea
                          id="vpn-config"
                          rows={6}
                          value={wizardData.vpnConfig}
                          onChange={e => setWizardData(prev => ({ ...prev, vpnConfig: e.target.value }))}
                          placeholder={wizardData.vpnProtocol === 'wireguard' ? "[Interface]\nPrivateKey = ...\nAddress = ...\nDNS = ...\n\n[Peer]\nPublicKey = ...\nEndpoint = ..." : "client\ndev tun\nproto udp\nremote ..."}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 font-mono text-xs focus:border-blue-500 focus:outline-none transition-all text-slate-300 placeholder:text-slate-700 leading-relaxed custom-scrollbar"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
              {wizardStep === 4 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Zap className="text-yellow-500" size={18}/> Component: {wizardData.appType.charAt(0).toUpperCase() + wizardData.appType.slice(1)}</h4><p className="text-slate-400 text-sm">Select the image version.</p></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label><input value={wizardData.odooRepo} onChange={e => setWizardData({...wizardData, odooRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" /></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Available Tags</label>{loadingOdooTags ? (<div className="flex items-center gap-2 text-slate-500 py-3"><Loader2 size={16} className="animate-spin" /> Fetching tags...</div>) : (<div className="grid grid-cols-2 gap-2">{odooTags.map((tag: string) => (<button key={tag} onClick={() => setWizardData({...wizardData, odooTag: tag})} className={`px-4 py-2 rounded-lg text-left text-xs border transition-all ${wizardData.odooTag === tag ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>{tag}</button>))}</div>)}</div>
                </div>
              )}
              {wizardStep === 5 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10"><h4 className="font-bold flex items-center gap-2 mb-2"><Database className="text-green-500" size={18}/> Component: Database</h4><p className="text-slate-400 text-sm">Select the database version.</p></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label><input value={wizardData.pgRepo} onChange={e => setWizardData({...wizardData, pgRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" /></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Available Tags</label>{loadingPgTags ? (<div className="flex items-center gap-2 text-slate-500 py-3"><Loader2 size={16} className="animate-spin" /> Fetching tags...</div>) : (<div className="grid grid-cols-2 gap-2">{pgTags.map((tag: string) => (<button key={tag} onClick={() => setWizardData({...wizardData, pgTag: tag})} className={`px-4 py-2 rounded-lg text-left text-xs border transition-all ${wizardData.pgTag === tag ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>{tag}</button>))}</div>)}</div>
                </div>
              )}
              {wizardStep === 6 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-8 bg-green-500/5 rounded-3xl border border-green-500/20 text-center"><div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4"><Check className="text-green-500" size={32} /></div><h4 className="text-xl font-bold">Ready to Launch</h4><p className="text-slate-400 text-sm">Confirm the configuration for <strong>{wizardData.name}</strong>.</p></div>
                  <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-700 space-y-4 text-sm">
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>Cluster</span><span className="font-bold text-slate-300">{clusters.find((c:any) => c.id === wizardData.clusterId)?.name}</span></div>
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>Strategy</span><span className="font-bold text-blue-400 uppercase tracking-widest text-[10px]">{wizardData.strategy}</span></div>
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>{wizardData.appType.charAt(0).toUpperCase() + wizardData.appType.slice(1)}</span><span className="font-mono text-xs text-slate-300">{wizardData.odooRepo}:{wizardData.odooTag}</span></div>
                    {APP_DEFAULTS[wizardData.appType].hasDatabase && (
                      <div className="flex justify-between border-b border-slate-800 pb-3"><span>Database</span><span className="font-mono text-xs text-slate-300">{wizardData.pgRepo}:{wizardData.pgTag}</span></div>
                    )}
                    <div className="flex justify-between">
                      <span>VPN Routing</span>
                      <span className="font-bold text-slate-300 flex items-center gap-1.5">
                        {wizardData.vpnEnabled ? (
                          <>
                            <span className="text-green-400 uppercase tracking-widest text-[10px] bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 flex items-center gap-1">
                              <Shield size={10} /> Active ({wizardData.vpnProtocol})
                            </span>
                            {wizardData.vpnDedicatedIp && <span className="font-mono text-xs text-slate-400">({wizardData.vpnDedicatedIp})</span>}
                          </>
                        ) : (
                          <span className="text-slate-500 uppercase tracking-widest text-[10px]">Disabled</span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-10 flex gap-4 pt-8 border-t border-slate-700">{wizardStep > 1 && (<button onClick={prevStep} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2"><ArrowLeft size={18} /> Back</button>)}<div className="flex-1"></div>{wizardStep < 6 ? (<button disabled={(wizardStep === 1 && !wizardData.clusterId)} onClick={nextStep} className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 disabled:opacity-50">Next <ArrowRight size={18} /></button>) : (<button onClick={() => deployApp.mutate(wizardData)} className="px-10 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold">🚀 Initiate Deployment</button>)}</div>
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

      {showNginxWizard && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Proxy Exposure Wizard</h3>
              <div className="flex items-center gap-4">
                <div className="flex gap-2">
                  {[1, 2, 3].map(s => (
                    <div key={s} className={`w-8 h-1.5 rounded-full transition-all ${nginxWizardStep >= s ? 'bg-blue-500' : 'bg-slate-700'}`}></div>
                  ))}
                </div>
                <button onClick={() => setShowNginxWizard(false)} className="text-slate-400 hover:text-white transition-colors" aria-label="Close Wizard">
                  <X size={24} />
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
              {nginxWizardStep === 1 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                    <h4 className="font-bold flex items-center gap-2 mb-2"><Package className="text-blue-500" size={18}/> Select Application</h4>
                    <p className="text-slate-400 text-sm">Choose the deployment instance you wish to expose over Nginx.</p>
                  </div>
                  <div>
                    <label htmlFor="nginx-wizard-app" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Application Instance</label>
                    <select
                      id="nginx-wizard-app"
                      value={nginxWizardData.deploymentId}
                      onChange={e => {
                        const dep = deployments.find((d: any) => d.id === e.target.value);
                        setNginxWizardData(prev => ({
                          ...prev,
                          deploymentId: e.target.value,
                          domain: dep ? `${dep.name.toLowerCase()}.vpn.local` : ''
                        }));
                      }}
                      className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100"
                    >
                      <option value="">Select an application...</option>
                      {deployments.map((d: any) => {
                        const cluster = clusters.find((c: any) => c.id === d.clusterId);
                        return (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.appType}) on {cluster ? cluster.name : 'Unknown'}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </div>
              )}

              {nginxWizardStep === 2 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                    <h4 className="font-bold flex items-center gap-2 mb-2"><Shield className="text-blue-500" size={18}/> Domain & Traffic Settings</h4>
                    <p className="text-slate-400 text-sm">Configure the hostname and transfer settings for this proxy rule.</p>
                  </div>
                  <div>
                    <label htmlFor="nginx-wizard-domain" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Proxy Hostname</label>
                    <input 
                      id="nginx-wizard-domain"
                      type="text"
                      value={nginxWizardData.domain}
                      onChange={e => setNginxWizardData(prev => ({ ...prev, domain: e.target.value }))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100 font-mono"
                      placeholder="e.g. odoo.vpn.local"
                    />
                  </div>
                  <div>
                    <label htmlFor="nginx-wizard-upload-limit" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Client Max Body Size (Upload Limit)</label>
                    <select
                      id="nginx-wizard-upload-limit"
                      value={nginxWizardData.maxBodySize}
                      onChange={e => setNginxWizardData(prev => ({ ...prev, maxBodySize: e.target.value }))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100"
                    >
                      <option value="1M">1 Megabyte (Standard API)</option>
                      <option value="10M">10 Megabytes (Standard Web Apps)</option>
                      <option value="100M">100 Megabytes (WordPress Media)</option>
                      <option value="1G">1 Gigabyte (Nextcloud Small Files)</option>
                      <option value="10G">10 Gigabytes (Large Backups / DB Dumps)</option>
                    </select>
                  </div>
                </div>
              )}

              {nginxWizardStep === 3 && (() => {
                const dep = deployments.find((d: any) => d.id === nginxWizardData.deploymentId);
                const cluster = dep ? clusters.find((c: any) => c.id === dep.clusterId) : null;
                const clusterName = cluster ? cluster.name : 'unknown';
                const ns = dep ? dep.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : '';
                const serviceName = dep ? (dep.appType === 'prometheus' ? 'prometheus-server' : dep.appType || 'odoo') : '';
                const port = dep ? (dep.appType === 'odoo' ? '8069' : '80') : '80';
                const internalDns = `http://${serviceName}.${ns}.svc.cluster.local:${port}`;
                
                const generatedConfig = `
    # Proxy configuration for ${dep ? dep.name : ''} (${dep ? dep.appType : ''}) on cluster ${clusterName}
    server {
        listen 80;
        server_name ${nginxWizardData.domain};
        client_max_body_size ${nginxWizardData.maxBodySize};

        location / {
            resolver 127.0.0.11 valid=10s;
            set $upstream "${serviceName}.${ns}.svc.cluster.local:${port}";
            proxy_pass http://$upstream;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }`;

                const handleInjectAndClose = () => {
                  if (editorContent.includes('http {')) {
                    const lastBraceIdx = editorContent.lastIndexOf('}');
                    if (lastBraceIdx !== -1) {
                      const newContent = editorContent.slice(0, lastBraceIdx) + generatedConfig + '\n' + editorContent.slice(lastBraceIdx);
                      setEditorContent(newContent);
                      setShowNginxWizard(false);
                      return;
                    }
                  }
                  setEditorContent(prev => prev + '\n' + generatedConfig);
                  setShowNginxWizard(false);
                };

                return (
                  <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                    <div className="p-6 bg-green-500/5 rounded-2xl border border-green-500/10">
                      <h4 className="font-bold flex items-center gap-2 mb-2"><Check className="text-green-500" size={18}/> Review Configuration</h4>
                      <p className="text-slate-400 text-sm">Review the generated Nginx proxy block configuration before injecting.</p>
                    </div>
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6">
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-3">Generated Nginx server block</span>
                      <pre className="bg-slate-950 p-4 rounded-xl font-mono text-xs text-slate-300 overflow-x-auto max-h-[30vh] custom-scrollbar border border-slate-800">
                        {generatedConfig.trim()}
                      </pre>
                    </div>
                    
                    <div className="mt-8 flex gap-4 pt-6 border-t border-slate-700">
                      <button onClick={() => setNginxWizardStep(2)} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2 font-bold transition-all"><ArrowLeft size={18} /> Back</button>
                      <div className="flex-1"></div>
                      <button onClick={handleInjectAndClose} className="px-8 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold transition-all flex items-center gap-2">🚀 Inject into config & Close</button>
                    </div>
                  </div>
                );
              })()}
            </div>
            
            {nginxWizardStep < 3 && (
              <div className="mt-8 flex gap-4 pt-6 border-t border-slate-700">
                {nginxWizardStep > 1 && (
                  <button onClick={() => setNginxWizardStep(1)} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2 font-bold transition-all"><ArrowLeft size={18} /> Back</button>
                )}
                <button onClick={() => setShowNginxWizard(false)} className="px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold transition-all">Cancel</button>
                <div className="flex-1"></div>
                <button
                  disabled={nginxWizardStep === 1 && !nginxWizardData.deploymentId || nginxWizardStep === 2 && !nginxWizardData.domain}
                  onClick={() => setNginxWizardStep(s => s + 1)}
                  className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 font-bold disabled:opacity-50 transition-all"
                >
                  Next <ArrowRight size={18} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
