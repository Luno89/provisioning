import { useState, useEffect } from 'react';
import KoalaChat from './components/KoalaChat';
import Sidebar from './components/Sidebar';
import NginxView from './components/NginxView';
import ClustersView from './components/ClustersView';
import AppsView from './components/AppsView';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Activity, AlertTriangle, BellRing, Cloud, GitBranch, Key, Loader2, Network, Package, Puzzle, Server, Shield, Timer } from 'lucide-react';
import TemporalPanel from './TemporalPanel.js';
import ServicesPanel from './ServicesPanel.js';
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

const API_BASE = (import.meta.env?.VITE_API_BASE as string) || 'http://localhost:3001/api';

axios.defaults.withCredentials = true;

/**
 * Everything that is infrastructure rather than the harness.
 *
 * A table rather than eleven hand-written buttons: they differed only in id, icon and label, and
 * every style tweak previously meant eleven identical edits.
 */
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

/**
 * Every view the URL may name.
 *
 * Anything else — a stale bookmark to a retired view, a typo — is resolved rather than rendered as
 * a blank page. See RETIRED_VIEWS in lib/route.ts.
 */
/**
 * Mirrors APP_TYPES in apps/backend/src/lib/app-catalog.ts — the frontend does not import backend
 * modules, so this is the one copy on this side rather than the two inline unions it replaced.
 */



function App() {
  const queryClient = useQueryClient();
  /**
   * ── SHELL STATE LIVES IN A STORE ──
   *
   * These were seven `useState` hooks here, plus two effects keeping `view` and the URL in step,
   * plus fifteen raw setters passed down as props. They are `stores/shell.ts` now: `setView` writes
   * the hash itself, so the two cannot drift, and a child that needs the view subscribes rather
   * than being handed a setter it could put anything into.
   *
   * Read through selectors with the same names the markup below already uses, so this file's 2,800
   * lines did not have to be edited to move the state. Components subscribe directly as their own
   * slices land — Sidebar already does.
   */
  const view = useShellStore((s) => s.view);
  const setView = useShellStore((s) => s.setView);
  const handoff = useShellStore((s) => s.handoff);
  const setHandoff = useShellStore((s) => s.setHandoff);
  const user = useShellStore((s) => s.user);
  const setUser = useShellStore((s) => s.setUser);
  const authLoading = useShellStore((s) => s.authLoading);
  const setAuthLoading = useShellStore((s) => s.setAuthLoading);

  // Back and Forward. Without this the buttons left the application entirely, because nothing had
  // ever pushed an entry.
  useEffect(() => startHistorySync(), []);

  const [editorContent, setEditorContent] = useState('');
  const [showClusterModal, setShowClusterModal] = useState(false);
  /** A bring-your-own cluster waiting for its generated public key to be authorised. */
  const [pendingKey, setPendingKey] = useState<{ id: string; publicKey: string } | null>(null);
  /** Set by the VPS Catalog's Deploy button so the wizard opens on that exact plan and location. */
  const [wizardPreset, setWizardPreset] = useState<{ provider: string; serverType?: string; location?: string } | undefined>(undefined);
  /**
   * The deploy wizard's state — step, form data, the advanced toggles, the model search box and
   * five debounced mirrors of it — moved into `components/AppDeployWizard/` along with the six
   * queries App ran on its behalf. App decides whether it is open and what happens on deploy.
   */
  const [showAppModal, setShowAppModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState<{ type: 'cluster' | 'app', id: string } | null>(null);
  const confirmDestroy = useShellStore((s) => s.confirmDestroy);
  const setConfirmDestroy = useShellStore((s) => s.setConfirmDestroy);
  const notifications = useShellStore((s) => s.notifications);
  const pushNotification = useShellStore((s) => s.pushNotification);
  const dismissNotification = useShellStore((s) => s.dismissNotification);
  const clearDestroyFor = useShellStore((s) => s.clearDestroyFor);
  
  const [logTab, setLogTab] = useState<'general' | 'provision' | 'helm' | 'app' | 'diagnostics' | 'modules' | 'storage'>('general');
  // Schema-driven settings for game servers, edited in the Config tab. Seeded from the
  // deployment record when the tab opens (see the effect that hydrates configInputs).
  const [vpnDomains, setVpnDomains] = useState<Record<string, string>>({});
  const [showNginxWizard, setShowNginxWizard] = useState(false);
  useEffect(() => {
    fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setUser(data);
        }
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false));
  }, []);

  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
      setUser(null);
      setView('clusters');
    } catch (err) {
      console.error('Logout failed', err);
    }
  };


  // Unified Wizard State

  const { data: clusters = [] } = useQuery({ queryKey: ['clusters'], queryFn: () => axios.get(`${API_BASE}/clusters`).then(res => res.data), refetchInterval: 3000 });
  const { data: deployments = [] } = useQuery({ queryKey: ['deployments'], queryFn: () => axios.get(`${API_BASE}/deployments`).then(res => res.data), refetchInterval: 3000 });
  const { data: credentialsData } = useQuery({ queryKey: ['credentials'], queryFn: () => axios.get(`${API_BASE}/credentials`).then(res => res.data) });

  const currentDeployment = showLogModal?.type === 'app' ? deployments.find((d: any) => d.id === showLogModal.id) : null;
  const currentCluster = showLogModal?.type === 'cluster' ? clusters.find((c: any) => c.id === showLogModal.id) : null;



  /**
   * The three cluster-detail queries that used to live here — pods, Helm releases and GPU status,
   * all keyed on `expandedCluster` — are `useClusterDetail` inside ClustersView now. App was
   * running queries on a child's behalf and handing back six data/loading values, for state the
   * child owned.
   */

  

  
  // Custom Modules Queries


  // Which image tags the running TabbyAPI image actually supports — fetched live rather than
  // hardcoded, since ghcr.io/theroyallab/tabbyapi's published tags can change upstream (new
  // CUDA variants added/dropped) independent of this codebase. Local tags come from the host
  // Docker cache (deploys instantly, no pull) and are merged with what's downloadable from the
  // registry so the picker shows both, distinguishing which is which.

  // Debounced so this doesn't fire on every keystroke while typing a model ID or context length
  // — HuggingFace's API is cheap but there's no reason to hit it on every digit.
  /**
   * Debounced so typing a model name is one request to the Hugging Face API rather than one per
   * character. Seven `useState` mirrors and three copies of the same `setTimeout`/`clearTimeout`
   * effect, replaced by `lib/use-debounce.ts`.
   */

  // Same VRAM-estimate treatment as TabbyAPI above, adapted for vLLM's own fields: no revision
  // concept (vLLM doesn't split quants across HF branches the way EXL2/EXL3 repos do), and dtype
  // instead of cache_mode — mapped to 'FP16' (2 bytes/element) for every realistic vLLM dtype
  // (auto/half/float16/bfloat16 are all 2 bytes; float32 is rare enough for LLM serving that this
  // doesn't special-case it separately, same caveat-labeled estimate as the TabbyAPI side).

  // Shared model-search picker for both vLLM and TabbyAPI wizard steps — replaces what used to
  // be a static hardcoded list of 4-5 models with a live HuggingFace search. An empty query
  // still returns results (sorted by downloads), so it doubles as a "trending models" list.
  // Only relevant for TabbyAPI — EXL2/EXL3 quants split their bpw variants across branches of




  /**
   * ── BROADCAST EVENTS, ON THE SHARED CONNECTION ──
   *
   * This opened one of the app's three `io()` connections. The two log rooms it also managed have
   * moved to `useLogSocket` below, which owns the rejoin-and-clear on reconnect that used to live
   * in this effect's `socket.on('reconnect')` block.
   */
  useSocketEvent<{ id: string }>('resource-destroyed', (data) => {
    // The store assigns the key. It used to be `Date.now()` here, which collides when two
    // resources finish in the same millisecond and hands React duplicate keys.
    pushNotification(data);

    // Close anything that was showing the resource that just went away.
    setShowLogModal((current) => (current && current.id === data.id) ? null : current);
    clearDestroyFor(data.id);
    // Collapsing the expanded cluster row is ClustersView's own reaction now — it owns that
    // state, so it listens for this event itself.

    queryClient.invalidateQueries({ queryKey: ['clusters'] });
    queryClient.invalidateQueries({ queryKey: ['deployments'] });
    setTimeout(() => dismissNotification(useShellStore.getState().notifications.at(-1)?.nid ?? 0), 5000);
  });

  useSocketEvent('deployment-updated', () => {
    queryClient.invalidateQueries({ queryKey: ['deployments'] });
  });










  /**
   * Every mutation below reports its failure.
   *
   * ── WHY THIS IS HERE ──
   * None of them did. A rejected POST left the wizard open with no message and no console error,
   * so "click Deploy, nothing happens" was the entire user-visible symptom — and it was also the
   * entire E2E failure report: a heading that never appeared, with no way to learn why from the
   * artefacts. Diagnosing it needed a hand-driven browser and a request interceptor.
   *
   * `errorMessage` reads the server's `{ error }` body before falling back to the axios message,
   * so a 404 "Cluster not found" reaches the user as those words rather than "Request failed with
   * status code 404".
   */
  const reportFailure = (what: string) => (err: unknown) =>
    pushNotification({ type: 'error', message: `${what}: ${errorMessage(err)}` });

  const provisionCluster = useMutation({
    mutationFn: (newCluster: any) => axios.post(`${API_BASE}/clusters`, newCluster),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setShowClusterModal(false);
      setWizardPreset(undefined);
      // A bring-your-own machine has not started provisioning: the backend generated a keypair and
      // is holding it until the user authorises the public half. Jumping to the provisioning log
      // here would show an empty log for a workflow that does not exist.
      if (res.data.status === 'awaiting-key') {
        setPendingKey({ id: res.data.id, publicKey: res.data.publicKey });
        return;
      }
      setShowLogModal({ type: 'cluster', id: res.data.id });
      setLogTab('provision');
    },
    onError: reportFailure('Could not provision the cluster'),
  });

  const startAwaitingCluster = useMutation({
    mutationFn: (id: string) => axios.post(`${API_BASE}/clusters/${id}/start`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setPendingKey(null);
      setShowLogModal({ type: 'cluster', id: res.data.id });
      setLogTab('provision');
    },
    onError: reportFailure('Could not start the cluster'),
  });
  
  const deployApp = useMutation({ 
    mutationFn: (newApp: any) => axios.post(`${API_BASE}/deployments`, newApp), 
    onSuccess: (res) => { 
      queryClient.invalidateQueries({ queryKey: ['deployments'] }); 
      setShowAppModal(false); 
      setShowLogModal({ type: 'app', id: res.data.id }); 
      setLogTab('provision'); 
      // The wizard resets itself: it unmounts on close, so its state goes with it.
    },
    // Deliberately does NOT close the wizard: the configuration is still on screen, and the fix
    // for "Cluster not found" is usually to pick a different one.
    onError: reportFailure('Could not deploy the app'),
  });



  const destroyResource = useMutation({
    mutationFn: ({ type, id }: any) => axios.delete(`${API_BASE}/${type === 'cluster' ? 'clusters' : 'deployments'}/${id}`),
    onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: ['clusters'] });
        queryClient.invalidateQueries({ queryKey: ['deployments'] });
        setConfirmDestroy(null);
        setShowLogModal({ type: variables.type, id: variables.id });
        setLogTab('provision');
    },
    onError: reportFailure('Could not destroy that'),
  });

  // No separate "abort" mutation: DELETE /api/clusters/:id and /api/deployments/:id already
  // detect a still-provisioning/deploying resource server-side and abort it instead of trying to
  // destroy something that was never fully created — see index.ts's delete handlers. A dedicated
  // Abort button/mutation calling POST .../abort did the exact same thing through a second path,
  // which just meant two buttons for one operation.




  const { data: nginxConfig, isLoading: loadingNginxConfig } = useQuery({
    queryKey: ['nginx-config'],
    queryFn: () => axios.get(`${API_BASE}/nginx/config`).then(res => res.data),
    enabled: view === 'nginx'
  });

  const updateNginxConfig = useMutation({
    mutationFn: (newContent: string) => axios.post(`${API_BASE}/nginx/config`, { content: newContent }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nginx-config'] });
    },
    // NginxView renders `updateNginxConfig.isError` itself, so this adds the toast rather than
    // replacing that — a config save is worth noticing from another screen.
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
    return <Login apiBase={API_BASE} onSuccess={setUser} />;
  }

  return (
    <div className="min-h-screen bg-[var(--bark-900)] canopy text-slate-100 flex font-sans overflow-hidden">
      <Sidebar forestTabs={FOREST_TABS} onLogout={handleLogout} />

      <main className="flex-1 p-10 overflow-y-auto relative">
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
        {view === 'lab' && <Lab apiBase={API_BASE} />}
        {view === 'grove' && (
          <Grove apiBase={API_BASE} handoff={handoff} onHandoffTaken={() => setHandoff(undefined)} />
        )}

        {view === 'chat' && (
          <KoalaChat
            apiBase={API_BASE}
            onOpenTree={() => setView('grove')}
          />
        )}

        {view === 'personas' && <Personas apiBase={API_BASE} />}

        {view === 'vps-catalog' && (
          <VpsCatalog
            apiBase={API_BASE}
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
          <Projects apiBase={API_BASE} clusters={clusters} />
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
                 // Always DELETE, whether this is showing as "Abort" or "Destroy" — the backend
                 // (index.ts's delete handlers) already checks whether the resource is still
                 // provisioning/deploying and aborts instead of destroying when it is. isAbort
                 // here only picks which confirmation copy to show, not which request to send.
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
          /**
           * Keyed on the resource, so opening a different one remounts rather than carrying the
           * previous deployment's tab, pod selection and half-edited config across.
           */
          key={showLogModal.id}
          target={showLogModal}
          deployment={currentDeployment}
          deployments={deployments}
          clusters={clusters}
          cluster={currentCluster}
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
          // Remounts when the preset changes, so a second Deploy click from the catalogue seeds
          // fresh initial state instead of reusing the first plan's.
          key={wizardPreset ? `${wizardPreset.provider}:${wizardPreset.serverType}:${wizardPreset.location}` : 'blank'}
          apiBase={API_BASE}
          configuredProviders={credentialsData?.providers ?? []}
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
