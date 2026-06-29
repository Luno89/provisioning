import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Layout, Server, Plus, Cloud, Terminal, FileText, X, Trash2, Zap, Cpu, Loader2, AlertTriangle, BellRing, ChevronDown, ChevronUp, Check, ArrowRight, ArrowLeft, Package, Database, Layers, Activity, Box, Blocks, ExternalLink, Puzzle, HardDrive, Shield } from 'lucide-react';
const API_BASE = import.meta.env?.VITE_API_BASE || 'http://localhost:3001/api';
const SOCKET_URL = import.meta.env?.VITE_SOCKET_URL || 'http://localhost:3001';
const APP_DEFAULTS = {
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
    const [view, setView] = useState('clusters');
    const [editorContent, setEditorContent] = useState('');
    const [showClusterModal, setShowClusterModal] = useState(false);
    const [showAppModal, setShowAppModal] = useState(false);
    const [showLogModal, setShowLogModal] = useState(null);
    const [confirmDestroy, setConfirmDestroy] = useState(null);
    const [expandedCluster, setExpandedCluster] = useState(null);
    const [notifications, setNotifications] = useState([]);
    const [logTab, setLogTab] = useState('general');
    const [storageInputs, setStorageInputs] = useState({});
    const [selectedPod, setSelectedPod] = useState(null);
    const [socketLogs, setSocketLogs] = useState('');
    const [kubeLogs, setKubeLogs] = useState('');
    const logEndRef = useRef(null);
    const [vpnDomains, setVpnDomains] = useState({});
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
        appType: 'odoo',
        strategy: 'native',
        odooRepo: 'library/odoo',
        odooTag: '18.0',
        pgRepo: 'library/postgres',
        pgTag: '16.4',
        modules: [],
        vpnEnabled: false,
        vpnProtocol: 'wireguard',
        vpnConfig: '',
        vpnDedicatedIp: ''
    });
    const { data: clusters = [] } = useQuery({ queryKey: ['clusters'], queryFn: () => axios.get(`${API_BASE}/clusters`).then(res => res.data), refetchInterval: 3000 });
    const { data: deployments = [] } = useQuery({ queryKey: ['deployments'], queryFn: () => axios.get(`${API_BASE}/deployments`).then(res => res.data), refetchInterval: 3000 });
    const currentDeployment = showLogModal?.type === 'app' ? deployments.find((d) => d.id === showLogModal.id) : null;
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
            socket.on('log', (chunk) => setSocketLogs(prev => prev + chunk));
            if (showLogModal.type === 'app' && logTab === 'app' && selectedPod) {
                socket.emit('join-kube-room', showLogModal.id);
                const currentNamespace = podResponse?.namespace || 'odoo';
                socket.emit('tail-pod', { resourceId: showLogModal.id, podName: selectedPod, namespace: currentNamespace });
                socket.on('kube-log', (chunk) => setKubeLogs(prev => prev + chunk));
            }
            return () => {
                socket.emit('leave-room', showLogModal.id);
                if (showLogModal.type === 'app')
                    socket.emit('leave-kube-room', showLogModal.id);
                socket.disconnect();
                setSocketLogs('');
                setKubeLogs('');
            };
        }
    }, [showLogModal, logTab, selectedPod, podResponse, namespace]);
    useEffect(() => { if (logEndRef.current)
        logEndRef.current.scrollIntoView({ behavior: 'smooth' }); }, [socketLogs, kubeLogs, helmStatus, diagnostics]);
    const getSupportedVolumes = (appType, strategy) => {
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
    const getFallbackSize = (volume) => {
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
    const getVolumeDescription = (volume) => {
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
            const initial = {};
            supported.forEach((vol) => {
                initial[vol] = currentDeployment.storage?.[vol] || getFallbackSize(vol);
            });
            setStorageInputs(initial);
        }
    }, [currentDeployment?.id, logTab]);
    const provisionCluster = useMutation({ mutationFn: (newCluster) => axios.post(`${API_BASE}/clusters`, newCluster), onSuccess: (res) => { queryClient.invalidateQueries({ queryKey: ['clusters'] }); setShowClusterModal(false); setShowLogModal({ type: 'cluster', id: res.data.id }); setLogTab('provision'); } });
    const deployApp = useMutation({
        mutationFn: (newApp) => axios.post(`${API_BASE}/deployments`, newApp),
        onSuccess: (res) => {
            queryClient.invalidateQueries({ queryKey: ['deployments'] });
            setShowAppModal(false);
            setShowLogModal({ type: 'app', id: res.data.id });
            setLogTab('provision');
            setWizardStep(1);
        }
    });
    const updateAppModules = useMutation({
        mutationFn: ({ id, modules }) => axios.patch(`${API_BASE}/deployments/${id}/modules`, { modules }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['deployments'] });
            setLogTab('provision');
        }
    });
    const updateAppStorage = useMutation({
        mutationFn: ({ id, storage }) => axios.patch(`${API_BASE}/deployments/${id}/storage`, { storage }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['deployments'] });
            setLogTab('provision');
        }
    });
    const destroyResource = useMutation({
        mutationFn: ({ type, id }) => axios.delete(`${API_BASE}/${type === 'cluster' ? 'clusters' : 'deployments'}/${id}`),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: ['clusters'] });
            queryClient.invalidateQueries({ queryKey: ['deployments'] });
            setConfirmDestroy(null);
            setShowLogModal({ type: variables.type, id: variables.id });
            setLogTab('provision');
        }
    });
    const exposeApp = useMutation({
        mutationFn: (id) => axios.post(`${API_BASE}/deployments/${id}/expose`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['deployments'] });
        }
    });
    const unexposeApp = useMutation({
        mutationFn: (id) => axios.post(`${API_BASE}/deployments/${id}/unexpose`),
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
        mutationFn: (newContent) => axios.post(`${API_BASE}/nginx/config`, { content: newContent }),
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
            }
            else {
                setWizardStep(4);
            }
        }
        else if (wizardStep === 3) {
            setWizardStep(4);
        }
        else if (wizardStep === 4 && !config.hasDatabase) {
            setWizardStep(6);
        }
        else {
            setWizardStep(s => s + 1);
        }
    };
    const prevStep = () => {
        const config = APP_DEFAULTS[wizardData.appType];
        if (wizardStep === 4) {
            if (wizardData.strategy === 'native') {
                setWizardStep(3);
            }
            else {
                setWizardStep(2);
            }
        }
        else if (wizardStep === 3) {
            setWizardStep(2);
        }
        else if (wizardStep === 6 && !config.hasDatabase) {
            setWizardStep(4);
        }
        else {
            setWizardStep(s => s - 1);
        }
    };
    const handleAppTypeChange = (newAppType) => {
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
    const selectStrategy = (strat) => {
        const appType = wizardData.appType || 'odoo';
        const config = APP_DEFAULTS[appType];
        if (!config.strategies.includes(strat))
            return;
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
    const openDashboard = (type, id) => {
        setShowLogModal({ type, id });
        setLogTab(type === 'app' ? 'general' : 'provision');
    };
    return (_jsxs("div", { className: "min-h-screen bg-slate-900 text-slate-100 flex font-sans overflow-hidden", children: [_jsxs("aside", { className: "w-64 bg-slate-800 border-r border-slate-700 p-6 flex flex-col shadow-xl z-20", children: [_jsxs("div", { className: "flex items-center gap-2 mb-10", children: [_jsx(Layout, { className: "text-blue-500" }), _jsx("h1", { className: "text-xl font-bold tracking-tight", children: "Provisioner v2" })] }), _jsxs("nav", { className: "space-y-2 flex-1", children: [_jsxs("button", { onClick: () => setView('clusters'), className: `w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'clusters' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`, children: [_jsx(Cloud, { size: 20 }), " Clusters"] }), _jsxs("button", { onClick: () => setView('apps'), className: `w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'apps' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`, children: [_jsx(Server, { size: 20 }), " Applications"] }), _jsxs("button", { onClick: () => setView('nginx'), className: `w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${view === 'nginx' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`, children: [_jsx(Puzzle, { size: 20 }), " Nginx Router"] })] }), _jsxs("div", { className: "pt-6 border-t border-slate-700 flex items-center gap-3 text-slate-500 text-[10px] uppercase font-black tracking-widest", children: [_jsx(Terminal, { size: 14 }), " ", _jsx("span", { children: "Local Ops Active" })] })] }), _jsxs("main", { className: "flex-1 p-10 overflow-y-auto relative", children: [_jsx("div", { className: "fixed top-6 right-6 z-[60] space-y-3", children: notifications.map(n => (_jsxs("div", { className: `bg-slate-800 border-l-4 ${n.outOfBand ? 'border-yellow-500' : 'border-green-500'} p-4 rounded-lg shadow-2xl flex items-center gap-4 min-w-[300px] animate-in slide-in-from-right`, children: [_jsx(BellRing, { className: n.outOfBand ? 'text-yellow-500' : 'text-green-500', size: 20 }), _jsxs("div", { children: [_jsx("div", { className: "text-[10px] font-black uppercase text-slate-500 tracking-tighter", children: n.outOfBand ? 'External Event' : 'System Event' }), _jsxs("div", { className: "text-sm font-bold", children: [n.name, " ", n.outOfBand ? 'Deleted Externally' : 'Destroyed'] })] })] }, n.nid))) }), view === 'clusters' && (_jsxs("section", { children: [_jsxs("header", { className: "flex justify-between items-center mb-10", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-3xl font-bold", children: "Infrastructures" }), _jsx("p", { className: "text-slate-400", children: "Manage your Kubernetes fleet." })] }), _jsxs("button", { onClick: () => setShowClusterModal(true), className: "bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105", children: [_jsx(Plus, { size: 20 }), " Provision Cluster"] })] }), _jsx("div", { className: "grid grid-cols-1 gap-8 max-w-5xl", children: clusters.map((c) => (_jsx("div", { className: "bg-slate-800 rounded-3xl border border-slate-700 overflow-hidden shadow-sm transition-all hover:border-slate-500", children: _jsxs("div", { className: "p-8", children: [_jsxs("div", { className: "flex justify-between items-center mb-6", children: [_jsxs("div", { className: "flex items-center gap-4", children: [_jsx("div", { className: "p-3 bg-blue-500/10 rounded-2xl text-blue-500", children: _jsx(Cloud, { size: 28 }) }), _jsxs("div", { children: [_jsx("h4", { className: "font-bold text-2xl", children: c.name }), _jsxs("span", { className: "text-[10px] font-mono text-slate-500 uppercase tracking-widest", children: [c.provider, " \u2022 ", c.id.slice(0, 8)] })] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("span", { className: `text-[10px] font-bold px-4 py-1.5 rounded-full uppercase flex items-center gap-2 ${c.status === 'healthy' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500 animate-pulse'}`, children: [_jsx("div", { className: `w-2 h-2 rounded-full ${c.status === 'healthy' ? 'bg-green-500' : 'bg-yellow-500'}` }), c.status] }), _jsx("button", { onClick: () => setShowLogModal({ type: 'cluster', id: c.id }), className: "p-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-slate-300 transition-colors", children: _jsx(FileText, { size: 20 }) }), _jsx("button", { onClick: () => setConfirmDestroy({ type: 'cluster', id: c.id, name: c.name }), className: "p-2.5 bg-slate-700 hover:bg-red-600 rounded-xl text-red-400 hover:text-white transition-all", children: _jsx(Trash2, { size: 20 }) })] })] }), _jsxs("div", { className: "mt-4 pt-6 border-t border-slate-700/50", children: [_jsxs("button", { onClick: () => setExpandedCluster(expandedCluster === c.id ? null : c.id), className: "flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors uppercase tracking-widest", children: [expandedCluster === c.id ? _jsx(ChevronUp, { size: 14 }) : _jsx(ChevronDown, { size: 14 }), " Cluster Inspector"] }), expandedCluster === c.id && (_jsxs("div", { className: "mt-6 space-y-8 animate-in fade-in slide-in-from-top-2 duration-300", children: [_jsxs("div", { children: [_jsxs("h5", { className: "text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2", children: [_jsx(Layers, { size: 12, className: "text-blue-400" }), " Helm Chart Inventory"] }), loadingClusterHelm ? (_jsx("div", { className: "text-slate-500 text-xs italic", children: "Scanning Helm repository..." })) : clusterHelmReleases?.length > 0 ? (_jsx("div", { className: "grid grid-cols-2 gap-4", children: clusterHelmReleases.map((release) => (_jsxs("div", { className: "bg-slate-900/50 border border-slate-700 p-4 rounded-xl flex justify-between items-center", children: [_jsxs("div", { children: [_jsx("div", { className: "font-bold text-sm", children: release.name }), _jsxs("div", { className: "text-[10px] text-slate-500", children: [release.chart, " \u2022 v", release.app_version] })] }), _jsx("span", { className: `text-[9px] font-bold px-2 py-0.5 rounded-full uppercase ${release.status === 'deployed' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`, children: release.status })] }, release.name))) })) : _jsx("div", { className: "text-slate-600 text-xs italic", children: "No Helm charts installed." })] }), _jsxs("div", { children: [_jsxs("h5", { className: "text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2", children: [_jsx(Cpu, { size: 12, className: "text-blue-400" }), " Infrastructure Node Status"] }), loadingClusterPods ? (_jsx("div", { className: "text-center py-6", children: _jsx(Loader2, { className: "animate-spin text-slate-600 mx-auto", size: 24 }) })) : Array.isArray(clusterPods) && clusterPods.length > 0 ? (_jsx("div", { className: "bg-slate-900/50 rounded-2xl border border-slate-700/50 overflow-hidden", children: _jsxs("table", { className: "w-full text-left text-xs", children: [_jsx("thead", { className: "bg-slate-800/50 text-slate-500 uppercase tracking-tighter", children: _jsxs("tr", { children: [_jsx("th", { className: "px-6 py-3", children: "Namespace" }), _jsx("th", { className: "px-6 py-3", children: "Pod Name" }), _jsx("th", { className: "px-6 py-3", children: "Status" }), _jsx("th", { className: "px-6 py-3", children: "IP" }), _jsx("th", { className: "px-6 py-3 text-right", children: "Age" })] }) }), _jsx("tbody", { className: "divide-y divide-slate-800", children: clusterPods.map((pod) => (_jsxs("tr", { className: "hover:bg-slate-800/30 transition-colors group", children: [_jsx("td", { className: "px-6 py-4 font-mono text-[10px] text-blue-400/80", children: pod?.metadata?.namespace || '---' }), _jsx("td", { className: "px-6 py-4 font-bold text-slate-300 group-hover:text-white truncate max-w-[200px]", children: pod?.metadata?.name || 'Unknown' }), _jsx("td", { className: "px-6 py-4", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: `w-1.5 h-1.5 rounded-full ${pod?.status?.phase === 'Running' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-yellow-500 animate-pulse'}` }), _jsx("span", { className: "font-medium text-slate-400", children: pod?.status?.phase || 'Pending' })] }) }), _jsx("td", { className: "px-6 py-4 font-mono text-slate-500 text-[10px]", children: pod?.status?.podIP || '---' }), _jsx("td", { className: "px-6 py-4 text-right text-slate-600", children: pod?.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).toLocaleTimeString() : '---' })] }, pod?.metadata?.name || Math.random()))) })] }) })) : _jsx("div", { className: "text-center py-6 bg-slate-900/30 rounded-2xl border border-dashed border-slate-700 text-slate-500 text-sm", children: podError ? 'API Error' : 'No nodes active.' })] })] }))] })] }) }, c.id))) })] })), view === 'apps' && (_jsxs("section", { children: [_jsxs("header", { className: "flex justify-between items-center mb-10", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-3xl font-bold", children: "Applications" }), _jsx("p", { className: "text-slate-400", children: "Deploy application instances." })] }), _jsxs("button", { onClick: () => { setShowAppModal(true); setWizardStep(1); setWizardData({ name: 'Odoo-Production', clusterId: '', appType: 'odoo', strategy: 'native', odooRepo: 'library/odoo', odooTag: '18.0', pgRepo: 'library/postgres', pgTag: '16.4', modules: [], vpnEnabled: false, vpnProtocol: 'wireguard', vpnConfig: '', vpnDedicatedIp: '' }); }, className: "bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105", children: [_jsx(Plus, { size: 20 }), " Deploy App"] })] }), _jsx("div", { className: "bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden shadow-sm", children: _jsxs("table", { className: "w-full text-left", children: [_jsx("thead", { className: "bg-slate-700/30 text-slate-400 text-[10px] uppercase tracking-widest font-bold", children: _jsxs("tr", { children: [_jsx("th", { className: "px-8 py-4", children: "App" }), _jsx("th", { className: "px-8 py-4", children: "Cluster" }), _jsx("th", { className: "px-8 py-4", children: "Strategy" }), _jsx("th", { className: "px-8 py-4", children: "Status" }), _jsx("th", { className: "px-8 py-4 text-right", children: "Actions" })] }) }), _jsx("tbody", { className: "divide-y divide-slate-700", children: deployments.map((a) => (_jsxs("tr", { className: "hover:bg-slate-700/10", children: [_jsx("td", { className: "px-8 py-5", children: _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-[10px] px-2.5 py-1 rounded-md font-bold uppercase tracking-wider bg-slate-900 border border-slate-700 text-slate-300", children: a.appType || 'odoo' }), _jsxs("div", { className: "flex flex-col gap-1", children: [a.status === 'running' ? (_jsxs("a", { href: a.url, target: "_blank", rel: "noreferrer", className: "group flex items-center gap-2 w-fit", children: [_jsx("span", { className: "font-bold text-xl text-blue-400 group-hover:text-blue-300 transition-colors underline decoration-blue-500/30 underline-offset-4", children: a.name }), _jsx(ExternalLink, { size: 16, className: "text-slate-600 group-hover:text-blue-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" })] })) : (_jsx("span", { className: "font-bold text-xl text-slate-500", children: a.name })), a.isExposed && a.exposureUrl && (_jsxs("a", { href: a.exposureUrl, target: "_blank", rel: "noreferrer", className: "group flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors w-fit font-semibold mt-1", children: [_jsxs("span", { children: ["Exposed: ", a.exposureUrl] }), _jsx(ExternalLink, { size: 12, className: "opacity-60 group-hover:opacity-100 transition-opacity" })] }))] })] }) }), _jsx("td", { className: "px-8 py-5 text-slate-400", children: clusters.find((c) => c.id === a.clusterId)?.name || 'Unknown' }), _jsx("td", { className: "px-8 py-5", children: _jsxs("div", { className: "flex flex-col gap-1.5 items-start", children: [_jsx("span", { className: "text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-slate-500/10 text-slate-400", children: a.strategy || 'helm' }), a.vpnEnabled && (_jsxs("span", { className: "text-[9px] px-2.5 py-0.5 rounded-md font-bold uppercase tracking-wider bg-green-500/10 text-green-400 border border-green-500/20 flex items-center gap-1", children: [_jsx(Shield, { size: 10 }), " VPN"] }))] }) }), _jsx("td", { className: "px-8 py-5", children: _jsx("span", { className: "text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-blue-500/10 text-blue-400", children: a.status }) }), _jsxs("td", { className: "px-8 py-5 text-right flex justify-end items-center gap-3", children: [_jsxs("button", { onClick: () => openDashboard('app', a.id), className: "px-4 py-2 bg-blue-600/10 hover:bg-blue-600 border border-blue-500/30 text-blue-400 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5", children: [_jsx(Activity, { size: 14 }), " Manage"] }), _jsxs("button", { onClick: () => setConfirmDestroy({ type: 'app', id: a.id, name: a.name }), className: "px-4 py-2 bg-slate-700/50 hover:bg-red-600 border border-slate-600 hover:border-red-500 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5", children: [_jsx(Trash2, { size: 14 }), " Destroy"] })] })] }, a.id))) })] }) })] })), view === 'nginx' && (_jsxs("section", { className: "animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-5xl", children: [_jsxs("header", { className: "flex justify-between items-center mb-10", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-3xl font-bold", children: "Nginx Router Settings" }), _jsx("p", { className: "text-slate-400", children: "Configure global ingress limits, custom proxy settings, and HTTP configurations." })] }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("button", { type: "button", onClick: () => { setShowNginxWizard(true); setNginxWizardStep(1); setNginxWizardData({ deploymentId: '', domain: '', maxBodySize: '10G' }); }, className: "bg-slate-700 hover:bg-slate-600 text-slate-200 px-5 py-2.5 rounded-xl flex items-center gap-2 font-semibold shadow-md transition-all cursor-pointer", children: [_jsx(Shield, { size: 18 }), " Proxy Wizard"] }), _jsxs("button", { disabled: loadingNginxConfig || updateNginxConfig.isPending, onClick: () => updateNginxConfig.mutate(editorContent), className: "bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl flex items-center gap-2 font-bold shadow-lg disabled:opacity-50 transition-all hover:scale-105 animate-all cursor-pointer", children: [updateNginxConfig.isPending ? (_jsx(Loader2, { className: "animate-spin", size: 18 })) : (_jsx(Check, { size: 18 })), "Save & Reload Nginx"] })] })] }), updateNginxConfig.isSuccess && (_jsxs("div", { className: "mb-6 p-4 bg-green-500/10 border border-green-500/20 text-green-400 rounded-xl text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95", children: [_jsx(Check, { size: 16 }), " Nginx configuration saved and reloaded successfully!"] })), updateNginxConfig.isError && (_jsxs("div", { className: "mb-6 p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95", children: [_jsx(AlertTriangle, { size: 16 }), " ", updateNginxConfig.error?.response?.data?.error || updateNginxConfig.error.message] })), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-8", children: [_jsx("div", { className: "lg:col-span-2 space-y-4", children: _jsxs("div", { className: "bg-slate-950 rounded-2xl border border-slate-800 p-6 shadow-inner relative flex flex-col h-[65vh]", children: [_jsxs("div", { className: "flex justify-between items-center mb-3", children: [_jsx("span", { className: "text-[10px] font-black text-slate-500 uppercase tracking-widest", children: "nginx.conf Editor" }), _jsx("span", { className: "text-[9px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono", children: "etc/nginx/nginx.conf" })] }), loadingNginxConfig ? (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsx(Loader2, { className: "animate-spin text-blue-500", size: 32 }) })) : (_jsx("textarea", { value: editorContent, onChange: (e) => setEditorContent(e.target.value), className: "flex-1 bg-transparent border-0 focus:ring-0 focus:outline-none p-0 font-mono text-xs text-slate-300 leading-relaxed resize-none custom-scrollbar", placeholder: "Loading configuration...", rows: 25 }))] }) }), _jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 text-sm text-slate-200 mb-4", children: [_jsx(Shield, { className: "text-blue-500", size: 16 }), " VPN Domain Routing Helper"] }), _jsx("p", { className: "text-slate-400 text-xs mb-4 leading-relaxed", children: "Generate Nginx reverse-proxy server blocks to route traffic from a dedicated VPN IP to your cluster's applications." }), deployments.length === 0 ? (_jsx("div", { className: "text-xs italic text-slate-500 py-3 text-center", children: "No active deployments found. Deploy an app first." })) : (_jsx("div", { className: "space-y-4 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar", children: deployments.map((d) => {
                                                            const cluster = clusters.find((c) => c.id === d.clusterId);
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
                                                            return (_jsxs("div", { className: "p-4 bg-slate-900/60 border border-slate-700/60 rounded-xl space-y-3", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { className: "font-bold text-slate-200 text-xs", children: d.name }), _jsx("span", { className: "text-[9px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono font-bold uppercase", children: d.appType || 'odoo' })] }), _jsxs("div", { className: "text-[10px] text-slate-400 space-y-1", children: [_jsxs("div", { children: [_jsx("span", { className: "text-slate-500", children: "Cluster:" }), " ", _jsx("span", { className: "font-mono text-slate-300", children: clusterName })] }), _jsxs("div", { children: [_jsx("span", { className: "text-slate-500", children: "Namespace:" }), " ", _jsx("span", { className: "font-mono text-slate-300", children: ns })] }), _jsxs("div", { children: [_jsx("span", { className: "text-slate-500", children: "Internal DNS:" }), " ", _jsx("span", { className: "font-mono text-[9px] text-slate-300", children: internalDns })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5", children: "Proxy Hostname" }), _jsx("input", { type: "text", value: currentDomain, onChange: e => setVpnDomains(prev => ({ ...prev, [domainKey]: e.target.value })), className: "w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-300 focus:border-blue-500 transition-all font-mono", placeholder: "e.g. app.vpn.local" })] }), _jsxs("div", { className: "flex gap-2 pt-1", children: [_jsxs("button", { onClick: handleInsert, className: "flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-1.5 px-3 rounded-lg text-[10px] transition-all flex items-center justify-center gap-1 cursor-pointer", children: [_jsx(Plus, { size: 12 }), " Inject config"] }), _jsx("button", { onClick: () => {
                                                                                    navigator.clipboard.writeText(nginxBlock);
                                                                                }, className: "bg-slate-700 hover:bg-slate-600 text-slate-300 font-bold py-1.5 px-3 rounded-lg text-[10px] transition-all cursor-pointer", children: "Copy" })] })] }, d.id));
                                                        }) }))] }), _jsxs("div", { className: "bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 text-sm text-slate-200 mb-4", children: [_jsx(Puzzle, { className: "text-blue-500", size: 16 }), " Configuration Hints"] }), _jsxs("div", { className: "space-y-4 text-xs text-slate-400 leading-relaxed", children: [_jsxs("p", { children: ["To configure file upload limits (e.g. for WordPress or Odoo ERP), add the following line inside the ", _jsx("code", { className: "bg-slate-900 px-1.5 py-0.5 rounded text-blue-400 font-mono", children: "http { ... }" }), " block:"] }), _jsx("pre", { className: "bg-slate-950 p-3 rounded-lg font-mono text-[11px] text-slate-300 border border-slate-800/60 leading-normal", children: "client_max_body_size 10G;" }), _jsx("p", { children: "This allows transfers of large database dumps, media, and system files without causing \"413 Request Entity Too Large\" errors." })] })] }), _jsxs("div", { className: "bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 text-sm text-slate-200 mb-4", children: [_jsx(Terminal, { className: "text-blue-500", size: 16 }), " Container Status"] }), _jsxs("div", { className: "space-y-3 text-xs text-slate-400", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { children: "Proxy Service" }), _jsx("span", { className: "font-bold text-green-400 bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 text-[10px] uppercase", children: "Active" })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { children: "Host Port" }), _jsx("span", { className: "font-mono text-slate-300", children: "80" })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { children: "Tunnel Port" }), _jsx("span", { className: "font-mono text-slate-300", children: "8000" })] })] })] })] })] })] }))] }), confirmDestroy && (_jsx("div", { className: "fixed inset-0 bg-red-950/40 backdrop-blur-md flex items-center justify-center p-6 z-[70]", children: _jsxs("div", { className: "bg-slate-900 border-2 border-red-500/30 rounded-3xl p-10 w-full max-md shadow-2xl animate-in zoom-in-95 duration-200", children: [_jsx("div", { className: "flex justify-center mb-6", children: _jsx("div", { className: "p-4 bg-red-500/10 rounded-full", children: _jsx(AlertTriangle, { className: "text-red-500", size: 40 }) }) }), _jsx("h3", { className: "text-2xl font-bold text-center mb-2", children: "Confirm Destruction" }), _jsxs("p", { className: "text-slate-400 text-center text-sm mb-8 leading-relaxed", children: ["Are you absolutely sure you want to destroy ", _jsx("strong", { children: confirmDestroy.name }), "?"] }), _jsxs("div", { className: "flex gap-4", children: [_jsx("button", { onClick: () => setConfirmDestroy(null), className: "flex-1 bg-slate-800 py-3 rounded-xl font-bold hover:bg-slate-700 transition-all", children: "Cancel" }), _jsx("button", { onClick: () => destroyResource.mutate({ type: confirmDestroy.type, id: confirmDestroy.id }), className: "flex-1 bg-red-600 py-3 rounded-xl font-bold hover:bg-red-500 shadow-lg transition-all", children: destroyResource.isPending ? _jsx(Loader2, { className: "animate-spin", size: 18 }) : 'Confirm Delete' })] })] }) })), showLogModal && (_jsx("div", { className: "fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center p-6 z-50", children: _jsxs("div", { className: "bg-slate-800 border border-slate-700 rounded-2xl p-8 w-full max-w-6xl h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-300", children: [_jsxs("div", { className: "flex justify-between items-start mb-6", children: [_jsxs("div", { className: "space-y-2 flex-1", children: [_jsxs("h3", { className: "text-2xl font-bold flex items-center gap-3", children: [_jsx(FileText, { className: "text-blue-500" }), showLogModal.type === 'app' ? `${currentDeployment?.name || 'Application'} Dashboard` : 'Execution Tracing'] }), _jsx("div", { className: "flex gap-4 border-b border-slate-700", children: showLogModal.type === 'app' ? (_jsxs(_Fragment, { children: [_jsxs("button", { onClick: () => setLogTab('general'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'general' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(Server, { size: 14 }), " General"] }), _jsxs("button", { onClick: () => setLogTab('provision'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'provision' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(Terminal, { size: 14 }), " Provisioning"] }), _jsxs("button", { onClick: () => setLogTab('app'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'app' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(Cpu, { size: 14 }), " Container Logs"] }), _jsxs("button", { onClick: () => setLogTab('helm'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'helm' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(Layers, { size: 14 }), " Helm Status"] }), _jsxs("button", { onClick: () => setLogTab('diagnostics'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'diagnostics' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(AlertTriangle, { size: 14 }), " Diagnostics"] }), _jsxs("button", { onClick: () => setLogTab('modules'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'modules' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(Puzzle, { size: 14 }), " Modules"] }), _jsxs("button", { onClick: () => setLogTab('storage'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'storage' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(HardDrive, { size: 14 }), " Storage"] })] })) : (_jsxs("button", { onClick: () => setLogTab('provision'), className: `pb-2 px-1 text-sm font-bold transition-all flex items-center gap-1.5 ${logTab === 'provision' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`, children: [_jsx(Terminal, { size: 14 }), " Infrastructure"] })) })] }), _jsx("button", { onClick: () => { setShowLogModal(null); setSelectedPod(null); }, className: "text-slate-400 hover:text-white", children: _jsx(X, { size: 24 }) })] }), _jsxs("div", { className: "flex-1 flex gap-6 min-h-0", children: [showLogModal.type === 'app' && logTab === 'app' && (_jsxs("div", { className: "w-64 bg-slate-900/50 rounded-xl border border-slate-700 p-4 overflow-y-auto", children: [_jsxs("div", { className: "text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2", children: [_jsx(Cpu, { size: 12 }), " Active Pods"] }), _jsx("div", { className: "space-y-2", children: pods.length > 0 ? pods.map((p) => (_jsxs("button", { onClick: () => { setSelectedPod(p.metadata.name); setKubeLogs(''); }, className: `w-full text-left p-3 rounded-lg text-xs transition-all border ${selectedPod === p?.metadata?.name ? 'bg-blue-600/20 border-blue-500 text-blue-100' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'}`, children: [_jsx("div", { className: "font-bold truncate", children: p?.metadata?.name || 'Unknown' }), _jsxs("div", { className: "flex items-center gap-1.5 mt-1 opacity-70", children: [_jsx("div", { className: `w-1.5 h-1.5 rounded-full ${p?.status?.phase === 'Running' ? 'bg-green-500' : 'bg-yellow-500'}` }), p?.status?.phase || 'Pending'] })] }, p?.metadata?.name || Math.random()))) : _jsx("div", { className: "text-[10px] text-slate-600 italic text-center py-4", children: "No pods detected." }) })] })), logTab === 'modules' && currentDeployment && (_jsxs("div", { className: "flex-1 flex flex-col min-h-0", children: [_jsxs("div", { className: "flex justify-between items-center mb-6", children: [_jsxs("div", { children: [_jsx("h4", { className: "text-xl font-bold", children: "Module Marketplace" }), _jsx("p", { className: "text-slate-400 text-xs", children: "Manage custom addons for this instance." })] }), _jsx("button", { disabled: updateAppModules.isPending, onClick: () => updateAppModules.mutate({ id: currentDeployment.id, modules: currentDeployment.modules }), className: "bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-all", children: updateAppModules.isPending ? _jsx(Loader2, { size: 16, className: "animate-spin" }) : _jsxs(_Fragment, { children: [_jsx(Check, { size: 16 }), " Apply Changes"] }) })] }), loadingModules ? (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsx(Loader2, { className: "animate-spin text-slate-600", size: 32 }) })) : (_jsx("div", { className: "grid grid-cols-2 gap-4 overflow-y-auto pr-2 custom-scrollbar", children: availableModules.map((mod) => {
                                                const isEnabled = currentDeployment.modules?.includes(mod.id);
                                                return (_jsxs("button", { onClick: () => {
                                                        const current = currentDeployment.modules || [];
                                                        const next = isEnabled ? current.filter((id) => id !== mod.id) : [...current, mod.id];
                                                        queryClient.setQueryData(['deployments'], (prev) => prev.map((d) => d.id === currentDeployment.id ? { ...d, modules: next } : d));
                                                    }, className: `p-6 rounded-2xl border-2 text-left transition-all ${isEnabled ? 'border-green-500 bg-green-500/5' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'}`, children: [_jsxs("div", { className: "flex justify-between items-start mb-4", children: [_jsx("div", { className: `p-3 rounded-xl ${isEnabled ? 'bg-green-500/20 text-green-500' : 'bg-slate-800 text-slate-400'}`, children: _jsx(Puzzle, { size: 24 }) }), _jsx("div", { className: `text-[10px] font-black uppercase px-2 py-1 rounded-md ${isEnabled ? 'bg-green-500 text-white' : 'bg-slate-800 text-slate-500'}`, children: isEnabled ? 'Enabled' : 'Disabled' })] }), _jsx("div", { className: "font-bold text-lg mb-1", children: mod.name }), _jsx("div", { className: "text-xs text-slate-400 line-clamp-2 leading-relaxed", children: mod.summary || mod.description }), _jsxs("div", { className: "mt-4 pt-4 border-t border-slate-800/50 flex justify-between items-center text-[10px] font-bold text-slate-500", children: [_jsxs("span", { children: ["By ", mod.author] }), _jsxs("span", { children: ["v", mod.version] })] })] }, mod.id));
                                            }) }))] })), logTab === 'storage' && currentDeployment && (_jsxs("div", { className: "flex-1 flex flex-col min-h-0", children: [_jsxs("div", { className: "flex justify-between items-center mb-6", children: [_jsxs("div", { children: [_jsx("h4", { className: "text-xl font-bold", children: "Storage Volumes Management" }), _jsx("p", { className: "text-slate-400 text-xs", children: "Resize persistent disk volumes allocated to this instance." })] }), _jsx("button", { disabled: updateAppStorage.isPending || getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy).length === 0, onClick: () => updateAppStorage.mutate({ id: currentDeployment.id, storage: storageInputs }), className: "bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-all disabled:opacity-50 cursor-pointer", children: updateAppStorage.isPending ? _jsx(Loader2, { size: 16, className: "animate-spin" }) : _jsxs(_Fragment, { children: [_jsx(Check, { size: 16 }), " Apply Changes"] }) })] }), getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy).length === 0 ? (_jsx("div", { className: "flex-1 flex items-center justify-center border border-slate-700/50 rounded-2xl bg-slate-900/20 p-8", children: _jsxs("div", { className: "text-center max-w-sm space-y-4", children: [_jsx("div", { className: "inline-flex p-4 bg-slate-800 rounded-full border border-slate-700 text-slate-500", children: _jsx(HardDrive, { size: 32 }) }), _jsx("h5", { className: "text-base font-bold text-slate-300", children: "No Volumes Configured" }), _jsx("p", { className: "text-xs text-slate-500 leading-relaxed", children: "This application strategy does not use or support dynamic persistent volume claims." })] }) })) : (_jsx("div", { className: "grid grid-cols-2 gap-4 overflow-y-auto pr-2 custom-scrollbar", children: getSupportedVolumes(currentDeployment.appType || '', currentDeployment.strategy).map((vol) => {
                                                const currentVal = currentDeployment.storage?.[vol] || getFallbackSize(vol);
                                                const iconMap = {
                                                    db: _jsx(Database, { className: "text-blue-400", size: 24 }),
                                                    web: _jsx(Layers, { className: "text-indigo-400", size: 24 }),
                                                    library: _jsx(HardDrive, { className: "text-purple-400", size: 24 }),
                                                    metadata: _jsx(Box, { className: "text-pink-400", size: 24 }),
                                                    config: _jsx(Server, { className: "text-orange-400", size: 24 }),
                                                    server: _jsx(Activity, { className: "text-amber-400", size: 24 })
                                                };
                                                const nameMap = {
                                                    db: 'Database Volume',
                                                    web: 'Web Assets Volume',
                                                    library: 'Library Volume',
                                                    metadata: 'Metadata Volume',
                                                    config: 'Config Volume',
                                                    server: 'Server Storage'
                                                };
                                                return (_jsxs("div", { className: "p-6 rounded-2xl border border-slate-700 bg-slate-900/50 flex flex-col justify-between gap-4", children: [_jsxs("div", { className: "flex justify-between items-start", children: [_jsxs("div", { className: "flex gap-4", children: [_jsx("div", { className: "p-3 rounded-xl bg-slate-800 text-slate-400", children: iconMap[vol] || _jsx(HardDrive, { size: 24 }) }), _jsxs("div", { children: [_jsx("div", { className: "font-bold text-base text-slate-200", children: nameMap[vol] || vol }), _jsxs("div", { className: "text-[10px] text-slate-400 mt-0.5 uppercase font-mono tracking-wider", children: ["Key: ", vol] })] })] }), _jsxs("div", { className: "text-[10px] font-black uppercase px-2 py-1 rounded bg-slate-800 text-slate-400 border border-slate-700", children: ["Current: ", currentVal] })] }), _jsx("div", { className: "text-xs text-slate-400 leading-relaxed min-h-[32px]", children: getVolumeDescription(vol) }), _jsxs("div", { className: "mt-2 flex items-center gap-4", children: [_jsx("label", { htmlFor: `vol-size-${vol}`, className: "text-xs text-slate-500 font-bold whitespace-nowrap", children: "Target Size:" }), _jsx("div", { className: "relative flex-1", children: _jsx("input", { id: `vol-size-${vol}`, type: "text", value: storageInputs[vol] || '', onChange: (e) => setStorageInputs(prev => ({ ...prev, [vol]: e.target.value })), className: "w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none transition-all", placeholder: "e.g. 5Gi" }) })] })] }, vol));
                                            }) }))] })), logTab === 'general' && currentDeployment && (_jsxs("div", { className: "flex-1 flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar", children: [currentDeployment.status === 'failed' && (_jsxs("div", { className: "bg-red-950/20 border-2 border-red-500/30 rounded-2xl p-6 flex flex-col gap-4 animate-in fade-in duration-300", children: [_jsxs("div", { className: "flex items-center gap-3 text-red-400", children: [_jsx(AlertTriangle, { size: 24 }), _jsx("h4", { className: "font-bold text-lg", children: "Deployment Failed" })] }), _jsx("p", { className: "text-slate-300 text-sm", children: "An error occurred during the provisioning process. Below is the end of the deployment logs:" }), _jsx("div", { className: "bg-slate-950 rounded-xl p-4 font-mono text-[11px] overflow-y-auto whitespace-pre-wrap border border-red-500/20 text-red-200/90 leading-relaxed max-h-60 shadow-inner", children: initialLogs?.content ? initialLogs.content.trim().split('\n').slice(-15).join('\n') : 'No provisioning logs found.' }), _jsx("div", { className: "flex justify-end", children: _jsxs("button", { onClick: () => setLogTab('provision'), className: "px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg shadow-red-950/50", children: [_jsx(Terminal, { size: 14 }), " View Full Logs"] }) })] })), _jsxs("div", { className: "grid grid-cols-4 gap-6", children: [_jsxs("div", { className: "bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl", children: [_jsx("div", { className: "text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1", children: "Status" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: `w-2.5 h-2.5 rounded-full ${currentDeployment.status === 'running' ? 'bg-green-500' : currentDeployment.status === 'deploying' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}` }), _jsx("span", { className: "font-bold text-lg uppercase text-slate-200", children: currentDeployment.status })] })] }), _jsxs("div", { className: "bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl", children: [_jsx("div", { className: "text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1", children: "Application Type" }), _jsx("span", { className: "font-bold text-lg text-slate-200 uppercase", children: currentDeployment.appType || 'odoo' })] }), _jsxs("div", { className: "bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl", children: [_jsx("div", { className: "text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1", children: "Orchestration" }), _jsx("span", { className: "font-bold text-lg text-slate-200 uppercase", children: currentDeployment.strategy || 'helm' })] }), _jsxs("div", { className: "bg-slate-900/50 border border-slate-700/60 p-6 rounded-2xl", children: [_jsx("div", { className: "text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1", children: "VPN Routing" }), _jsx("span", { className: "font-bold text-lg text-slate-200 uppercase flex items-center gap-1.5", children: currentDeployment.vpnEnabled ? (_jsxs("span", { className: "text-green-400 flex items-center gap-1", children: [_jsx(Shield, { size: 16 }), " Active (", currentDeployment.vpnProtocol, ")"] })) : (_jsx("span", { className: "text-slate-500", children: "Disabled" })) })] })] }), _jsxs("div", { className: "bg-gradient-to-r from-blue-950/30 to-indigo-950/30 border border-blue-500/20 rounded-2xl p-8 flex flex-col gap-6", children: [_jsxs("div", { children: [_jsxs("h4", { className: "text-xl font-bold mb-2 flex items-center gap-2", children: [_jsx(Zap, { className: "text-blue-400", size: 20 }), " Network Exposure"] }), _jsx("p", { className: "text-slate-400 text-sm leading-relaxed max-w-2xl", children: "Expose this application to the public network interfaces using our dynamic Nginx reverse proxy. This integrates container network routing, allowing external network access." })] }), _jsxs("div", { className: "flex flex-col gap-4 pt-4 border-t border-slate-800/80", children: [_jsx("div", { className: "flex items-center gap-4", children: currentDeployment.status === 'running' ? (_jsxs("button", { disabled: exposeApp.isPending || unexposeApp.isPending, onClick: () => currentDeployment.isExposed ? unexposeApp.mutate(currentDeployment.id) : exposeApp.mutate(currentDeployment.id), className: `px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all ${currentDeployment.isExposed ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20'}`, children: [(exposeApp.isPending || unexposeApp.isPending) ? (_jsx(Loader2, { size: 18, className: "animate-spin" })) : currentDeployment.isExposed ? (_jsx(X, { size: 18 })) : (_jsx(Check, { size: 18 })), currentDeployment.isExposed ? 'Unexpose Application' : 'Expose Application'] })) : (_jsxs("div", { className: "text-sm font-semibold text-yellow-500 bg-yellow-500/10 px-4 py-2.5 rounded-lg border border-yellow-500/20 flex items-center gap-2", children: [_jsx(AlertTriangle, { size: 16 }), " Exposure controls are only available when the deployment is running."] })) }), currentDeployment.isExposed && currentDeployment.exposureUrl && (_jsxs("div", { className: "mt-4 p-5 bg-slate-900/80 border border-slate-700 rounded-xl flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("div", { className: "text-[10px] font-black uppercase text-green-500 tracking-wider mb-1", children: "Public Access URL" }), _jsxs("a", { href: currentDeployment.exposureUrl, target: "_blank", rel: "noreferrer", className: "group flex items-center gap-1.5 text-base font-bold text-blue-400 hover:text-blue-300 transition-colors", children: [_jsx("span", { children: currentDeployment.exposureUrl }), _jsx(ExternalLink, { size: 16, className: "opacity-70 group-hover:opacity-100 transition-opacity" })] })] }), _jsx("span", { className: "text-xs font-semibold px-3 py-1 rounded bg-green-500/10 text-green-400 border border-green-500/20", children: "Active" })] }))] })] })] })), logTab !== 'modules' && logTab !== 'general' && logTab !== 'storage' && (_jsxs("div", { className: "flex-1 bg-slate-950 rounded-xl p-6 font-mono text-[11px] overflow-y-auto whitespace-pre-wrap border border-slate-700/50 shadow-inner custom-scrollbar text-blue-100/90 leading-relaxed relative", children: [logTab === 'provision' ? (((initialLogs?.content || '') + socketLogs) || 'Loading flow...') :
                                            logTab === 'helm' ? (helmStatus?.content || 'Fetching Helm...') :
                                                logTab === 'diagnostics' ? (diagnostics?.content || 'Scanning cluster for errors...') :
                                                    (selectedPod ? (kubeLogs || `Connected...`) : 'Select a pod to begin tailing.'), _jsx("div", { ref: logEndRef })] }))] })] }) })), showAppModal && (_jsx("div", { className: "fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50", children: _jsxs("div", { className: "bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]", children: [_jsxs("div", { className: "flex justify-between items-center mb-8", children: [_jsx("h3", { className: "text-2xl font-bold", children: "Deployment Wizard" }), _jsxs("div", { className: "flex items-center gap-4", children: [_jsx("div", { className: "flex gap-2", children: [1, 2, 3, 4, 5, 6].map(s => {
                                                const config = APP_DEFAULTS[wizardData.appType];
                                                if (s === 3 && wizardData.strategy !== 'native')
                                                    return null;
                                                if (s === 5 && !config.hasDatabase)
                                                    return null;
                                                return (_jsx("div", { className: `w-8 h-1.5 rounded-full transition-all ${wizardStep >= s ? 'bg-blue-500' : 'bg-slate-700'}` }, s));
                                            }) }), _jsx("button", { onClick: () => setShowAppModal(false), className: "text-slate-400 hover:text-white transition-colors", "aria-label": "Close Wizard", children: _jsx(X, { size: 24 }) })] })] }), _jsxs("div", { className: "flex-1 overflow-y-auto pr-2 custom-scrollbar", children: [wizardStep === 1 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Package, { className: "text-blue-500", size: 18 }), " Target Configuration"] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Select the infrastructure, name, and application type." })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "wizard-instance-name", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Instance Name" }), _jsx("input", { id: "wizard-instance-name", value: wizardData.name, onChange: e => setWizardData({ ...wizardData, name: e.target.value }), className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all" })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "wizard-target-cluster", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Target Cluster" }), _jsxs("select", { id: "wizard-target-cluster", value: wizardData.clusterId, onChange: e => setWizardData({ ...wizardData, clusterId: e.target.value }), className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all", children: [_jsx("option", { value: "", children: "Select a healthy cluster..." }), clusters.filter((c) => c.status === 'healthy').map((c) => (_jsxs("option", { value: c.id, children: [c.name, " (", c.provider, ")"] }, c.id)))] })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "wizard-app-type", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Application Type" }), _jsxs("select", { id: "wizard-app-type", value: wizardData.appType, onChange: e => handleAppTypeChange(e.target.value), className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100", children: [_jsx("option", { value: "odoo", children: "Odoo ERP" }), _jsx("option", { value: "wordpress", children: "WordPress CMS" }), _jsx("option", { value: "nextcloud", children: "Nextcloud Cloud Storage" }), _jsx("option", { value: "audiobookshelf", children: "Audiobookshelf Media Server" }), _jsx("option", { value: "prometheus", children: "Prometheus Monitoring Stack" }), _jsx("option", { value: "traefik", children: "Traefik Ingress Router" })] })] })] })), wizardStep === 2 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Blocks, { className: "text-blue-400", size: 18 }), " Deployment Strategy"] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Choose how the application is orchestrated." })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("button", { disabled: !APP_DEFAULTS[wizardData.appType].strategies.includes('helm'), onClick: () => selectStrategy('helm'), className: `p-6 rounded-2xl border-2 text-left transition-all relative ${!APP_DEFAULTS[wizardData.appType].strategies.includes('helm') ? 'opacity-40 cursor-not-allowed border-slate-800 bg-slate-900' : wizardData.strategy === 'helm' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`, children: [_jsx("div", { className: "p-3 bg-blue-500/20 rounded-xl w-fit mb-4", children: _jsx(Layers, { size: 24, className: "text-blue-500" }) }), _jsx("div", { className: "font-bold text-lg", children: "Helm Chart" }), _jsx("div", { className: "text-xs text-slate-400 mt-1", children: "Bitnami-managed stack. Includes advanced features and hardened images." }), !APP_DEFAULTS[wizardData.appType].strategies.includes('helm') && (_jsx("span", { className: "absolute top-4 right-4 text-[9px] font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 uppercase", children: "Not Supported" }))] }), _jsxs("button", { disabled: !APP_DEFAULTS[wizardData.appType].strategies.includes('native'), onClick: () => selectStrategy('native'), className: `p-6 rounded-2xl border-2 text-left transition-all relative ${!APP_DEFAULTS[wizardData.appType].strategies.includes('native') ? 'opacity-40 cursor-not-allowed border-slate-800 bg-slate-900' : wizardData.strategy === 'native' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`, children: [_jsx("div", { className: "p-3 bg-green-500/20 rounded-xl w-fit mb-4", children: _jsx(Box, { size: 24, className: "text-green-500" }) }), _jsx("div", { className: "font-bold text-lg", children: "Native K8s" }), _jsx("div", { className: "text-xs text-slate-400 mt-1", children: "Raw Kubernetes resources. Uses official library images directly." }), !APP_DEFAULTS[wizardData.appType].strategies.includes('native') && (_jsx("span", { className: "absolute top-4 right-4 text-[9px] font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 uppercase", children: "Not Supported" }))] })] })] })), wizardStep === 3 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Shield, { className: "text-blue-500", size: 18 }), " Windscribe VPN Routing"] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Secure and route this individual app instance through a dedicated VPN IP address." })] }), _jsxs("div", { className: "flex items-center justify-between p-4 bg-slate-900/60 border border-slate-700 rounded-2xl", children: [_jsxs("div", { children: [_jsx("div", { className: "font-bold text-sm text-slate-200", children: "Enable VPN Tunnel" }), _jsx("div", { className: "text-xs text-slate-400 mt-0.5", children: "Route container traffic through a Windscribe secure tunnel." })] }), _jsx("button", { type: "button", onClick: () => setWizardData(prev => ({ ...prev, vpnEnabled: !prev.vpnEnabled })), className: `relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${wizardData.vpnEnabled ? 'bg-blue-600' : 'bg-slate-700'}`, children: _jsx("span", { className: `inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${wizardData.vpnEnabled ? 'translate-x-6' : 'translate-x-1'}` }) })] }), wizardData.vpnEnabled && (_jsxs("div", { className: "space-y-5 animate-in fade-in slide-in-from-top-2 duration-200", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "VPN Tunneling Protocol" }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsx("button", { type: "button", onClick: () => setWizardData(prev => ({ ...prev, vpnProtocol: 'wireguard' })), className: `p-4 rounded-xl border text-center transition-all ${wizardData.vpnProtocol === 'wireguard' ? 'border-blue-500 bg-blue-500/10 text-white font-semibold' : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500'}`, children: "WireGuard (Fastest)" }), _jsx("button", { type: "button", onClick: () => setWizardData(prev => ({ ...prev, vpnProtocol: 'openvpn' })), className: `p-4 rounded-xl border text-center transition-all ${wizardData.vpnProtocol === 'openvpn' ? 'border-blue-500 bg-blue-500/10 text-white font-semibold' : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500'}`, children: "OpenVPN" })] })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "vpn-dedicated-ip", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Dedicated IP / Static IP" }), _jsx("input", { id: "vpn-dedicated-ip", type: "text", value: wizardData.vpnDedicatedIp, onChange: e => setWizardData(prev => ({ ...prev, vpnDedicatedIp: e.target.value })), placeholder: "e.g. 104.244.72.115", className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3.5 text-sm focus:border-blue-500 focus:outline-none transition-all placeholder:text-slate-600 text-slate-200" })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "vpn-config", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "VPN Configuration File Content" }), _jsx("textarea", { id: "vpn-config", rows: 6, value: wizardData.vpnConfig, onChange: e => setWizardData(prev => ({ ...prev, vpnConfig: e.target.value })), placeholder: wizardData.vpnProtocol === 'wireguard' ? "[Interface]\nPrivateKey = ...\nAddress = ...\nDNS = ...\n\n[Peer]\nPublicKey = ...\nEndpoint = ..." : "client\ndev tun\nproto udp\nremote ...", className: "w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 font-mono text-xs focus:border-blue-500 focus:outline-none transition-all text-slate-300 placeholder:text-slate-700 leading-relaxed custom-scrollbar" })] })] }))] })), wizardStep === 4 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Zap, { className: "text-yellow-500", size: 18 }), " Component: ", wizardData.appType.charAt(0).toUpperCase() + wizardData.appType.slice(1)] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Select the image version." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Docker Repository" }), _jsx("input", { value: wizardData.odooRepo, onChange: e => setWizardData({ ...wizardData, odooRepo: e.target.value }), className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Available Tags" }), loadingOdooTags ? (_jsxs("div", { className: "flex items-center gap-2 text-slate-500 py-3", children: [_jsx(Loader2, { size: 16, className: "animate-spin" }), " Fetching tags..."] })) : (_jsx("div", { className: "grid grid-cols-2 gap-2", children: odooTags.map((tag) => (_jsx("button", { onClick: () => setWizardData({ ...wizardData, odooTag: tag }), className: `px-4 py-2 rounded-lg text-left text-xs border transition-all ${wizardData.odooTag === tag ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`, children: tag }, tag))) }))] })] })), wizardStep === 5 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Database, { className: "text-green-500", size: 18 }), " Component: Database"] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Select the database version." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Docker Repository" }), _jsx("input", { value: wizardData.pgRepo, onChange: e => setWizardData({ ...wizardData, pgRepo: e.target.value }), className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Available Tags" }), loadingPgTags ? (_jsxs("div", { className: "flex items-center gap-2 text-slate-500 py-3", children: [_jsx(Loader2, { size: 16, className: "animate-spin" }), " Fetching tags..."] })) : (_jsx("div", { className: "grid grid-cols-2 gap-2", children: pgTags.map((tag) => (_jsx("button", { onClick: () => setWizardData({ ...wizardData, pgTag: tag }), className: `px-4 py-2 rounded-lg text-left text-xs border transition-all ${wizardData.pgTag === tag ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`, children: tag }, tag))) }))] })] })), wizardStep === 6 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-8 bg-green-500/5 rounded-3xl border border-green-500/20 text-center", children: [_jsx("div", { className: "w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4", children: _jsx(Check, { className: "text-green-500", size: 32 }) }), _jsx("h4", { className: "text-xl font-bold", children: "Ready to Launch" }), _jsxs("p", { className: "text-slate-400 text-sm", children: ["Confirm the configuration for ", _jsx("strong", { children: wizardData.name }), "."] })] }), _jsxs("div", { className: "bg-slate-900/50 rounded-2xl p-6 border border-slate-700 space-y-4 text-sm", children: [_jsxs("div", { className: "flex justify-between border-b border-slate-800 pb-3", children: [_jsx("span", { children: "Cluster" }), _jsx("span", { className: "font-bold text-slate-300", children: clusters.find((c) => c.id === wizardData.clusterId)?.name })] }), _jsxs("div", { className: "flex justify-between border-b border-slate-800 pb-3", children: [_jsx("span", { children: "Strategy" }), _jsx("span", { className: "font-bold text-blue-400 uppercase tracking-widest text-[10px]", children: wizardData.strategy })] }), _jsxs("div", { className: "flex justify-between border-b border-slate-800 pb-3", children: [_jsx("span", { children: wizardData.appType.charAt(0).toUpperCase() + wizardData.appType.slice(1) }), _jsxs("span", { className: "font-mono text-xs text-slate-300", children: [wizardData.odooRepo, ":", wizardData.odooTag] })] }), APP_DEFAULTS[wizardData.appType].hasDatabase && (_jsxs("div", { className: "flex justify-between border-b border-slate-800 pb-3", children: [_jsx("span", { children: "Database" }), _jsxs("span", { className: "font-mono text-xs text-slate-300", children: [wizardData.pgRepo, ":", wizardData.pgTag] })] })), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { children: "VPN Routing" }), _jsx("span", { className: "font-bold text-slate-300 flex items-center gap-1.5", children: wizardData.vpnEnabled ? (_jsxs(_Fragment, { children: [_jsxs("span", { className: "text-green-400 uppercase tracking-widest text-[10px] bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 flex items-center gap-1", children: [_jsx(Shield, { size: 10 }), " Active (", wizardData.vpnProtocol, ")"] }), wizardData.vpnDedicatedIp && _jsxs("span", { className: "font-mono text-xs text-slate-400", children: ["(", wizardData.vpnDedicatedIp, ")"] })] })) : (_jsx("span", { className: "text-slate-500 uppercase tracking-widest text-[10px]", children: "Disabled" })) })] })] })] }))] }), _jsxs("div", { className: "mt-10 flex gap-4 pt-8 border-t border-slate-700", children: [wizardStep > 1 && (_jsxs("button", { onClick: prevStep, className: "px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2", children: [_jsx(ArrowLeft, { size: 18 }), " Back"] })), _jsx("div", { className: "flex-1" }), wizardStep < 6 ? (_jsxs("button", { disabled: (wizardStep === 1 && !wizardData.clusterId), onClick: nextStep, className: "px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 disabled:opacity-50", children: ["Next ", _jsx(ArrowRight, { size: 18 })] })) : (_jsx("button", { onClick: () => deployApp.mutate(wizardData), className: "px-10 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold", children: "\uD83D\uDE80 Initiate Deployment" }))] })] }) })), showClusterModal && (_jsx("div", { className: "fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50", children: _jsxs("div", { className: "bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200", children: [_jsx("h3", { className: "text-2xl font-bold mb-8 text-center", children: "Provision New Cluster" }), _jsxs("form", { onSubmit: (e) => { e.preventDefault(); const d = new FormData(e.currentTarget); provisionCluster.mutate({ name: d.get('name'), provider: d.get('provider') }); }, children: [_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Cluster Identity" }), _jsx("input", { name: "name", required: true, className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 transition-all text-sm", placeholder: "e.g. production-omega" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Cloud Provider" }), _jsxs("select", { name: "provider", className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 focus:border-blue-500 text-sm", children: [_jsx("option", { value: "k3d", children: "Local Datacenter (k3d)" }), _jsx("option", { value: "aws", children: "Amazon Web Services (EKS)" }), _jsx("option", { value: "gcp", children: "Google Cloud Platform (GKE)" })] })] })] }), _jsxs("div", { className: "flex gap-4 mt-10", children: [_jsx("button", { type: "button", onClick: () => setShowClusterModal(false), className: "flex-1 bg-slate-700 py-3 rounded-xl font-bold hover:bg-slate-600 transition-all text-sm", children: "Cancel" }), _jsx("button", { type: "submit", className: "flex-1 bg-blue-600 py-3 rounded-xl font-bold shadow-lg shadow-blue-900/20 hover:bg-blue-500 transition-all text-sm", children: "Start Provisioning" })] })] })] }) })), showNginxWizard && (_jsx("div", { className: "fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50", children: _jsxs("div", { className: "bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]", children: [_jsxs("div", { className: "flex justify-between items-center mb-8", children: [_jsx("h3", { className: "text-2xl font-bold", children: "Proxy Exposure Wizard" }), _jsxs("div", { className: "flex items-center gap-4", children: [_jsx("div", { className: "flex gap-2", children: [1, 2, 3].map(s => (_jsx("div", { className: `w-8 h-1.5 rounded-full transition-all ${nginxWizardStep >= s ? 'bg-blue-500' : 'bg-slate-700'}` }, s))) }), _jsx("button", { onClick: () => setShowNginxWizard(false), className: "text-slate-400 hover:text-white transition-colors", "aria-label": "Close Wizard", children: _jsx(X, { size: 24 }) })] })] }), _jsxs("div", { className: "flex-1 overflow-y-auto pr-2 custom-scrollbar", children: [nginxWizardStep === 1 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Package, { className: "text-blue-500", size: 18 }), " Select Application"] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Choose the deployment instance you wish to expose over Nginx." })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "nginx-wizard-app", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Application Instance" }), _jsxs("select", { id: "nginx-wizard-app", value: nginxWizardData.deploymentId, onChange: e => {
                                                        const dep = deployments.find((d) => d.id === e.target.value);
                                                        setNginxWizardData(prev => ({
                                                            ...prev,
                                                            deploymentId: e.target.value,
                                                            domain: dep ? `${dep.name.toLowerCase()}.vpn.local` : ''
                                                        }));
                                                    }, className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100", children: [_jsx("option", { value: "", children: "Select an application..." }), deployments.map((d) => {
                                                            const cluster = clusters.find((c) => c.id === d.clusterId);
                                                            return (_jsxs("option", { value: d.id, children: [d.name, " (", d.appType, ") on ", cluster ? cluster.name : 'Unknown'] }, d.id));
                                                        })] })] })] })), nginxWizardStep === 2 && (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Shield, { className: "text-blue-500", size: 18 }), " Domain & Traffic Settings"] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Configure the hostname and transfer settings for this proxy rule." })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "nginx-wizard-domain", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Proxy Hostname" }), _jsx("input", { id: "nginx-wizard-domain", type: "text", value: nginxWizardData.domain, onChange: e => setNginxWizardData(prev => ({ ...prev, domain: e.target.value })), className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100 font-mono", placeholder: "e.g. odoo.vpn.local" })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "nginx-wizard-upload-limit", className: "block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2", children: "Client Max Body Size (Upload Limit)" }), _jsxs("select", { id: "nginx-wizard-upload-limit", value: nginxWizardData.maxBodySize, onChange: e => setNginxWizardData(prev => ({ ...prev, maxBodySize: e.target.value })), className: "w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100", children: [_jsx("option", { value: "1M", children: "1 Megabyte (Standard API)" }), _jsx("option", { value: "10M", children: "10 Megabytes (Standard Web Apps)" }), _jsx("option", { value: "100M", children: "100 Megabytes (WordPress Media)" }), _jsx("option", { value: "1G", children: "1 Gigabyte (Nextcloud Small Files)" }), _jsx("option", { value: "10G", children: "10 Gigabytes (Large Backups / DB Dumps)" })] })] })] })), nginxWizardStep === 3 && (() => {
                                    const dep = deployments.find((d) => d.id === nginxWizardData.deploymentId);
                                    const cluster = dep ? clusters.find((c) => c.id === dep.clusterId) : null;
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
                                    return (_jsxs("div", { className: "space-y-6 animate-in fade-in slide-in-from-right-4 duration-300", children: [_jsxs("div", { className: "p-6 bg-green-500/5 rounded-2xl border border-green-500/10", children: [_jsxs("h4", { className: "font-bold flex items-center gap-2 mb-2", children: [_jsx(Check, { className: "text-green-500", size: 18 }), " Review Configuration"] }), _jsx("p", { className: "text-slate-400 text-sm", children: "Review the generated Nginx proxy block configuration before injecting." })] }), _jsxs("div", { className: "bg-slate-900 border border-slate-700 rounded-2xl p-6", children: [_jsx("span", { className: "text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-3", children: "Generated Nginx server block" }), _jsx("pre", { className: "bg-slate-950 p-4 rounded-xl font-mono text-xs text-slate-300 overflow-x-auto max-h-[30vh] custom-scrollbar border border-slate-800", children: generatedConfig.trim() })] }), _jsxs("div", { className: "mt-8 flex gap-4 pt-6 border-t border-slate-700", children: [_jsxs("button", { onClick: () => setNginxWizardStep(2), className: "px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2 font-bold transition-all", children: [_jsx(ArrowLeft, { size: 18 }), " Back"] }), _jsx("div", { className: "flex-1" }), _jsx("button", { onClick: handleInjectAndClose, className: "px-8 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold transition-all flex items-center gap-2", children: "\uD83D\uDE80 Inject into config & Close" })] })] }));
                                })()] }), nginxWizardStep < 3 && (_jsxs("div", { className: "mt-8 flex gap-4 pt-6 border-t border-slate-700", children: [nginxWizardStep > 1 && (_jsxs("button", { onClick: () => setNginxWizardStep(1), className: "px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2 font-bold transition-all", children: [_jsx(ArrowLeft, { size: 18 }), " Back"] })), _jsx("button", { onClick: () => setShowNginxWizard(false), className: "px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold transition-all", children: "Cancel" }), _jsx("div", { className: "flex-1" }), _jsxs("button", { disabled: nginxWizardStep === 1 && !nginxWizardData.deploymentId || nginxWizardStep === 2 && !nginxWizardData.domain, onClick: () => setNginxWizardStep(s => s + 1), className: "px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 font-bold disabled:opacity-50 transition-all", children: ["Next ", _jsx(ArrowRight, { size: 18 })] })] }))] }) }))] }));
}
export default App;
//# sourceMappingURL=App.js.map