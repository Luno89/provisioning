import { useState, useEffect } from 'react';
import ChatPage from './components/ChatPage';
import Sidebar from './components/Sidebar';
import NginxView from './components/NginxView';
import ClustersView from './components/ClustersView';
import AppsView from './components/AppsView';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, BellRing, Cloud, GitBranch, Key, Loader2, Network, Package, Puzzle, Server, Shield, Timer } from 'lucide-react';
import TemporalPanel from './components/TemporalPanel';
import ServicesPanel from './components/ServicesPanel';
import Login from './components/Login.js';
import CloudAccounts from './components/CloudAccounts.js';
import Projects from './components/Projects.js';
import ClusterWizard from './components/ClusterWizard.js';
import VpsCatalog from './components/VpsCatalog.js';
import Lab from './components/Lab';
import Grove from './components/Grove.js';
import AppDeployWizard from './components/AppDeployWizard';
import AppDashboard from './components/AppDashboard';
import SettingsView from './components/SettingsView';
import PendingKeyModal from './components/PendingKeyModal';
import NginxWizard from './components/NginxWizard';
import { errorMessage } from './api/client';
import { useShellStore, startHistorySync } from './stores/shell';
import { useSocketEvent } from './stores/socket';
import MeshDevices from './components/MeshDevices.js';
import Personas from './components/Personas.js';
import { API_BASE } from './api/client';
import { getMe, logout } from './api/auth';
import {
  listClusters, clusterKeys, type ClusterCreated,
  provisionCluster as provisionClusterApi,
  startAwaitingCluster as startAwaitingClusterApi,
} from './api/clusters';
import {
  listDeployments, deploymentKeys,
  deployApp as deployAppApi,
  destroyResource as destroyResourceApi,
} from './api/deployments';
import { listProviders, credentialKeys } from './api/credentials';
import { getNginxConfig, saveNginxConfig, nginxKeys } from './api/nginx';

export { API_BASE };

const FOREST_TABS = [
  { id: 'clusters' as const, label: 'Clusters', icon: Cloud },
  { id: 'apps' as const, label: 'Applications', icon: Server },
  { id: 'projects' as const, label: 'Projects', icon: GitBranch },
  { id: 'vps-catalog' as const, label: 'VPS Catalog', icon: Package },
  { id: 'mesh' as const, label: 'My Machines', icon: Network },
  { id: 'accounts' as const, label: 'Cloud Accounts', icon: Key },
  { id: 'services' as const, label: 'Services', icon: Activity },
  { id: 'nginx' as const, label: 'Nginx Router', icon: Puzzle },
  { id: 'temporal' as const, label: 'Temporal', icon: Timer },
  { id: 'settings' as const, label: 'Security', icon: Shield },
];

function App() {
  const queryClient = useQueryClient();
  const view = useShellStore((s) => s.view);
  const setView = useShellStore((s) => s.setView);
  const handoff = useShellStore((s) => s.handoff);
  const setHandoff = useShellStore((s) => s.setHandoff);
  const user = useShellStore((s) => s.user);
  const setUser = useShellStore((s) => s.setUser);
  const authLoading = useShellStore((s) => s.authLoading);
  const setAuthLoading = useShellStore((s) => s.setAuthLoading);

  useEffect(() => startHistorySync(), []);

  const [editorContent, setEditorContent] = useState('');
  const [showClusterModal, setShowClusterModal] = useState(false);
  const [pendingKey, setPendingKey] = useState<{ id: string; publicKey: string } | null>(null);
  const [wizardPreset, setWizardPreset] = useState<{ provider: string; serverType?: string; location?: string } | undefined>(undefined);
  const [showAppModal, setShowAppModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState<{ type: 'cluster' | 'app', id: string } | null>(null);
  const confirmDestroy = useShellStore((s) => s.confirmDestroy);
  const setConfirmDestroy = useShellStore((s) => s.setConfirmDestroy);
  const notifications = useShellStore((s) => s.notifications);
  const pushNotification = useShellStore((s) => s.pushNotification);
  const dismissNotification = useShellStore((s) => s.dismissNotification);
  const clearDestroyFor = useShellStore((s) => s.clearDestroyFor);
  
  const [logTab, setLogTab] = useState<'general' | 'provision' | 'helm' | 'app' | 'diagnostics' | 'modules' | 'storage'>('general');
  const [vpnDomains, setVpnDomains] = useState<Record<string, string>>({});
  const [showNginxWizard, setShowNginxWizard] = useState(false);
  useEffect(() => {
    getMe()
      .then((data) => { if (data) setUser(data); })
      .finally(() => setAuthLoading(false));
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
      setUser(null);
      setView('clusters');
    } catch (err) {
      console.error('Logout failed', err);
    }
  };

  const { data: clusters = [] } = useQuery({ queryKey: clusterKeys.list(), queryFn: listClusters, refetchInterval: 3000 });
  const { data: deployments = [] } = useQuery({ queryKey: deploymentKeys.list(), queryFn: listDeployments, refetchInterval: 3000 });
  const { data: providers = [] } = useQuery({ queryKey: credentialKeys.list(), queryFn: listProviders });

  const currentDeployment = showLogModal?.type === 'app' ? deployments.find((d: any) => d.id === showLogModal.id) : null;
  const currentCluster = showLogModal?.type === 'cluster' ? clusters.find((c: any) => c.id === showLogModal.id) : null;

  useSocketEvent<{ id: string }>('resource-destroyed', (data) => {
    pushNotification(data);

    setShowLogModal((current) => (current && current.id === data.id) ? null : current);
    clearDestroyFor(data.id);

    queryClient.invalidateQueries({ queryKey: ['clusters'] });
    queryClient.invalidateQueries({ queryKey: ['deployments'] });
    setTimeout(() => dismissNotification(useShellStore.getState().notifications.at(-1)?.nid ?? 0), 5000);
  });

  useSocketEvent('deployment-updated', () => {
    queryClient.invalidateQueries({ queryKey: ['deployments'] });
  });

  const reportFailure = (what: string) => (err: unknown) =>
    pushNotification({ type: 'error', message: `${what}: ${errorMessage(err)}` });

  const provisionCluster = useMutation({
    mutationFn: (newCluster: unknown) => provisionClusterApi<ClusterCreated>(newCluster),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setShowClusterModal(false);
      setWizardPreset(undefined);
      if (res.status === 'awaiting-key') {
        setPendingKey({ id: res.id, publicKey: res.publicKey ?? '' });
        return;
      }
      setShowLogModal({ type: 'cluster', id: res.id });
      setLogTab('provision');
    },
    onError: reportFailure('Could not provision the cluster'),
  });

  const startAwaitingCluster = useMutation({
    mutationFn: (id: string) => startAwaitingClusterApi<ClusterCreated>(id),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setPendingKey(null);
      setShowLogModal({ type: 'cluster', id: res.id });
      setLogTab('provision');
    },
    onError: reportFailure('Could not start the cluster'),
  });
  
  const deployApp = useMutation({ 
    mutationFn: (newApp: unknown) => deployAppApi<{ id: string }>(newApp),
    onSuccess: (res) => { 
      queryClient.invalidateQueries({ queryKey: ['deployments'] }); 
      setShowAppModal(false); 
      setShowLogModal({ type: 'app', id: res.id }); 
      setLogTab('provision'); 
    },
    onError: reportFailure('Could not deploy the app'),
  });

  const destroyResource = useMutation({
    mutationFn: ({ type, id }: { type: 'cluster' | 'app'; id: string }) => destroyResourceApi(type, id),
    onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: ['clusters'] });
        queryClient.invalidateQueries({ queryKey: ['deployments'] });
        setConfirmDestroy(null);
        setShowLogModal({ type: variables.type, id: variables.id });
        setLogTab('provision');
    },
    onError: reportFailure('Could not destroy that'),
  });

  const { data: nginxConfig, isLoading: loadingNginxConfig } = useQuery({
    queryKey: nginxKeys.config(),
    queryFn: getNginxConfig,
    enabled: view === 'nginx'
  });

  const updateNginxConfig = useMutation({
    mutationFn: saveNginxConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nginx-config'] });
    },
    onError: reportFailure('Could not save the nginx config'),
  });

  useEffect(() => {
    if (nginxConfig?.content !== undefined) {
      setEditorContent(nginxConfig.content);
    }
  }, [nginxConfig]);

  const openDashboard = (type: 'cluster' | 'app', id: string) => {
    setShowLogModal({ type, id });
    setLogTab(type === 'app' ? 'general' : 'provision');
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0d0f14] text-slate-100 font-sans">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Login onSuccess={setUser} />;
  }

  return (
    <div className="h-screen max-h-screen bg-[var(--bark-900)] canopy text-slate-100 flex font-sans overflow-hidden">
      <Sidebar forestTabs={FOREST_TABS} onLogout={handleLogout} />

      <main className={`flex-1 h-full min-h-0 ${view === 'chat' ? 'p-0 overflow-hidden' : 'p-10 overflow-y-auto'} relative flex flex-col`}>
        <div className="fixed top-6 right-6 z-[60] space-y-3">
          {notifications.map(n => (<div key={n.nid} className={`bg-slate-800 border-l-4 ${n.outOfBand ? 'border-yellow-500' : 'border-green-500'} p-4 rounded-lg shadow-2xl flex items-center gap-4 min-w-[300px] animate-in slide-in-from-right`}><BellRing className={n.outOfBand ? 'text-yellow-500' : 'text-green-500'} size={20} /><div><div className="text-[10px] font-black uppercase text-slate-500 tracking-tighter">{n.outOfBand ? 'External Event' : 'System Event'}</div><div className="text-sm font-bold">{n.name} {n.outOfBand ? 'Deleted Externally' : 'Destroyed'}</div></div></div>))}
        </div>

        {view === 'clusters' && (
          <ClustersView
            clusters={clusters}
            onProvision={() => setShowClusterModal(true)}
            onOpenLogs={(id) => openDashboard('cluster', id)}
          />
        )}

        {view === 'apps' && (
          <AppsView
            deployments={deployments}
            clusters={clusters}
            onDeploy={() => setShowAppModal(true)}
            onOpenLogs={(id) => openDashboard('app', id)}
          />
        )}

        {view === 'nginx' && (
          <NginxView
            editorContent={editorContent}
            setEditorContent={setEditorContent}
            loadingNginxConfig={loadingNginxConfig}
            updateNginxConfig={updateNginxConfig}
            deployments={deployments}
            clusters={clusters}
            vpnDomains={vpnDomains}
            setVpnDomains={setVpnDomains}
            onAddRoute={() => setShowNginxWizard(true)}
          />
        )}
        {view === 'temporal' && <TemporalPanel />}
        {view === 'services' && <ServicesPanel />}
        {view === 'accounts' && (
          <CloudAccounts />
        )}
        {view === 'mesh' && <MeshDevices />}
        {view === 'lab' && <Lab />}
        {view === 'grove' && (
          <Grove handoff={handoff} onHandoffTaken={() => setHandoff(undefined)} />
        )}

        {view === 'chat' && <ChatPage />}

        {view === 'personas' && <Personas />}

        {view === 'vps-catalog' && (
          <VpsCatalog
            onDeploy={(offer) => {
              setWizardPreset({
                provider: offer.provider,
                serverType: offer.planId,
                ...(offer.location ? { location: offer.location } : {}),
              });
              setShowClusterModal(true);
            }}
          />
        )}
        {view === 'projects' && (
          <Projects clusters={clusters} />
        )}

        {view === 'settings' && <SettingsView />}
      </main>

      {confirmDestroy && (
        <div className="fixed inset-0 bg-red-950/40 backdrop-blur-md flex items-center justify-center p-6 z-[70]">
           <div className={`bg-slate-900 border-2 ${confirmDestroy.isAbort ? 'border-amber-500/30' : 'border-red-500/30'} rounded-3xl p-10 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200`}>
             <div className="flex justify-center mb-6">
               <div className={`p-4 ${confirmDestroy.isAbort ? 'bg-amber-500/10' : 'bg-red-500/10'} rounded-full`}>
                 <AlertTriangle className={confirmDestroy.isAbort ? 'text-amber-500' : 'text-red-500'} size={40} />
               </div>
             </div>
             <h3 className="text-2xl font-bold text-center mb-2">{confirmDestroy.isAbort ? 'Abort Provisioning' : 'Confirm Destruction'}</h3>
             <p className="text-slate-400 text-center text-sm mb-8 leading-relaxed">
               {confirmDestroy.isAbort
                 ? <>Are you sure you want to abort provisioning <strong>{confirmDestroy.name}</strong>? Active Temporal workflows will be terminated and partial infrastructure will be cleaned up.</>
                 : <>Are you absolutely sure you want to destroy <strong>{confirmDestroy.name}</strong>?</>}
             </p>
             <div className="flex gap-4">
               <button onClick={() => setConfirmDestroy(null)} className="flex-1 bg-slate-800 py-3 rounded-xl font-bold hover:bg-slate-700 transition-all cursor-pointer">Cancel</button>
               <button
                 onClick={() => destroyResource.mutate({ type: confirmDestroy.type, id: confirmDestroy.id })}
                 className={`flex-1 ${confirmDestroy.isAbort ? 'bg-amber-600 hover:bg-amber-500' : 'bg-red-600 hover:bg-red-500'} py-3 rounded-xl font-bold shadow-lg transition-all cursor-pointer flex items-center justify-center`}
               >
                 {destroyResource.isPending ? <Loader2 className="animate-spin" size={18} /> : (confirmDestroy.isAbort ? 'Abort & Teardown' : 'Confirm Delete')}
               </button>
             </div>
           </div>
        </div>
      )}

      {showLogModal && (
        <AppDashboard
          key={showLogModal.id}
          target={showLogModal}
          deployment={currentDeployment ?? null}
          deployments={deployments}
          clusters={clusters}
          cluster={currentCluster ?? null}
          initialTab={logTab}
          onClose={() => setShowLogModal(null)}
        />
      )}

      {showAppModal && (
        <AppDeployWizard
          clusters={clusters}
          deployments={deployments}
          preset={wizardPreset as never}
          onClose={() => setShowAppModal(false)}
          onDeploy={(payload) => deployApp.mutate(payload as never)}
        />
      )}

      {showClusterModal && (
        <ClusterWizard
          key={wizardPreset ? `${wizardPreset.provider}:${wizardPreset.serverType}:${wizardPreset.location}` : 'blank'}
          configuredProviders={providers}
          submitting={provisionCluster.isPending}
          onCancel={() => { setShowClusterModal(false); setWizardPreset(undefined); }}
          onCredentialsSaved={() => queryClient.invalidateQueries({ queryKey: ['credentials'] })}
          onSubmit={(payload) => provisionCluster.mutate(payload)}
          {...(wizardPreset ? { preset: wizardPreset } : {})}
        />
      )}

      {pendingKey && (
        <PendingKeyModal
          pending={pendingKey}
          onDismiss={() => setPendingKey(null)}
          onStart={(id) => startAwaitingCluster.mutate(id)}
          starting={startAwaitingCluster.isPending}
          startError={startAwaitingCluster.isError ? errorMessage(startAwaitingCluster.error) : null}
        />
      )}

      {showNginxWizard && (
        <NginxWizard
          clusters={clusters}
          deployments={deployments}
          onClose={() => setShowNginxWizard(false)}
          onAppend={setEditorContent}
        />
      )}
    </div>
  );
}

export default App;
