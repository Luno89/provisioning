import { useState, useEffect } from 'react';
import KoalaChat from './components/KoalaChat';
import Sidebar from './components/Sidebar';
import NginxView from './components/NginxView';
import ClustersView from './components/ClustersView';
import AppsView from './components/AppsView';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, BellRing, Check, Cloud, GitBranch, Key, Loader2, Network, Package, Puzzle, Server, Shield, Timer, X } from 'lucide-react';
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
import { useShellStore, startHistorySync, type AppUser } from './stores/shell';
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
  const [nginxWizardStep, setNginxWizardStep] = useState(1);
  const [nginxWizardData, setNginxWizardData] = useState({
    deploymentId: '',
    domain: '',
    maxBodySize: '10G',
  });

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

  const update2FASettings = async (enabled: boolean, phone?: string, preferredMethod?: 'email' | 'sms') => {
    try {
      const res = await fetch(`${API_BASE}/auth/2fa/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, phone, preferredMethod }),
      });
      if (res.ok) {
        const data = await res.json();
        // A plain setter, not a React dispatch: read the current user rather than passing an
        // updater function. `useShellStore.getState()` is the escape hatch for exactly this — a
        // value needed inside a callback that must not re-run when it changes.
        const current = useShellStore.getState().user;
        setUser({
          ...(current as AppUser),
          twoFactorEnabled: data.twoFactorEnabled,
          twoFactorPhone: data.twoFactorPhone,
          twoFactorPreferredMethod: data.twoFactorPreferredMethod,
        } as AppUser);
      }
    } catch (err) {
      console.error('Failed to update 2FA settings', err);
    }
  };

  // Unified Wizard State

  const { data: clusters = [] } = useQuery({ queryKey: ['clusters'], queryFn: () => axios.get(`${API_BASE}/clusters`).then(res => res.data), refetchInterval: 3000 });
  const { data: deployments = [] } = useQuery({ queryKey: ['deployments'], queryFn: () => axios.get(`${API_BASE}/deployments`).then(res => res.data), refetchInterval: 3000 });
  const { data: credentialsData } = useQuery({ queryKey: ['credentials'], queryFn: () => axios.get(`${API_BASE}/credentials`).then(res => res.data) });
  const { data: invites = [] } = useQuery({ queryKey: ['invites'], queryFn: () => axios.get(`${API_BASE}/admin/invites`).then(res => res.data), enabled: !!user?.isAdmin });
  const mintInvite = useMutation({
    mutationFn: () => axios.post(`${API_BASE}/admin/invites`, {}).then(res => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
  });

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
  });

  const startAwaitingCluster = useMutation({
    mutationFn: (id: string) => axios.post(`${API_BASE}/clusters/${id}/start`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setPendingKey(null);
      setShowLogModal({ type: 'cluster', id: res.data.id });
      setLogTab('provision');
    },
  });
  
  const deployApp = useMutation({ 
    mutationFn: (newApp: any) => axios.post(`${API_BASE}/deployments`, newApp), 
    onSuccess: (res) => { 
      queryClient.invalidateQueries({ queryKey: ['deployments'] }); 
      setShowAppModal(false); 
      setShowLogModal({ type: 'app', id: res.data.id }); 
      setLogTab('provision'); 
      // The wizard resets itself: it unmounts on close, so its state goes with it.
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
    }
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
            setShowNginxWizard={setShowNginxWizard}
            setNginxWizardStep={setNginxWizardStep}
            setNginxWizardData={setNginxWizardData}
          />
        )}
        {view === 'temporal' && <TemporalPanel />}
        {view === 'services' && <ServicesPanel />}
        {view === 'accounts' && (
          <CloudAccounts />
        )}
        {view === 'mesh' && <MeshDevices apiBase={API_BASE} />}
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

        {view === 'settings' && (
          <section className="max-w-xl">
            <header className="mb-10">
              <h2 className="text-3xl font-bold">Security & Settings</h2>
              <p className="text-slate-400">Configure authentication and two-factor (2FA) mechanisms.</p>
            </header>
            
            <div className="bg-slate-800 border border-slate-700 rounded-3xl p-8 space-y-6">
              <div>
                <h4 className="text-lg font-bold text-white mb-1">User Account Details</h4>
                <div className="text-sm text-slate-300 space-y-2 mt-3">
                  <div><strong>Email:</strong> {user.email}</div>
                  <div><strong>Account ID:</strong> <span className="font-mono text-xs">{user.id}</span></div>
                  <div><strong>Created:</strong> {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</div>
                </div>
              </div>

              <div className="pt-6 border-t border-slate-700">
                <h4 className="text-lg font-bold text-white mb-4">Two-Factor Authentication (2FA)</h4>
                
                <div className="space-y-4">
                  <div className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                    <div>
                      <div className="text-sm font-bold text-white">Enable 2FA Protection</div>
                      <div className="text-xs text-slate-400 mt-0.5">Require a one-time passcode on each sign-in attempt.</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={user.twoFactorEnabled}
                        onChange={(e) => update2FASettings(e.target.checked, user.twoFactorPhone, user.twoFactorPreferredMethod as 'email' | 'sms' | undefined)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>

                  {user.twoFactorEnabled && (
                    <div className="space-y-4 pt-2">
                      <div>
                        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Preferred Delivery Method</label>
                        <select
                          value={user.twoFactorPreferredMethod || 'email'}
                          onChange={(e) => update2FASettings(user.twoFactorEnabled ?? false, user.twoFactorPhone, e.target.value as 'email' | 'sms')}
                          className="block w-full px-4 py-3 bg-slate-900/50 border border-white/5 rounded-2xl text-white focus:outline-none focus:border-blue-500"
                        >
                          <option value="email">Email Notification</option>
                          <option value="sms">SMS Text Message</option>
                        </select>
                      </div>

                      {user.twoFactorPreferredMethod === 'sms' && (
                        <div>
                          <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Mobile Phone Number</label>
                          <input
                            type="text"
                            placeholder="e.g. +1234567890"
                            value={user.twoFactorPhone || ''}
                            onChange={(e) => update2FASettings(user.twoFactorEnabled ?? false, e.target.value, user.twoFactorPreferredMethod as 'email' | 'sms' | undefined)}
                            className="block w-full px-4 py-3 bg-slate-900/50 border border-white/5 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                          />
                          <p className="text-[10px] text-slate-500 mt-1">Include country code prefix (e.g. +1).</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-6 border-t border-slate-700">
                <h4 className="text-lg font-bold text-white mb-1">Cluster Service Access</h4>
                <p className="text-xs text-slate-400 mb-4">
                  How each auto-provisioned service on your clusters is secured. No credentials are ever shown here —
                  Grafana and Gitea log you in automatically (a real session, password never sent to your browser) when
                  you click "Open Dashboard" on the Cluster Services page.
                </p>
                <div className="space-y-2">
                  {[
                    { name: 'Grafana', detail: 'Signed in automatically as admin.', status: 'Auto-login', ok: true },
                    { name: 'Gitea', detail: 'Signed in automatically as provisioning-bot.', status: 'Auto-login', ok: true },
                    { name: 'Prometheus', detail: 'No login screen — open by design (local dev).', status: 'No auth', ok: false },
                    { name: 'Traefik Dashboard', detail: 'Runs in insecure/unauthenticated mode — local dev only.', status: 'No auth', ok: false },
                    { name: 'Alertmanager', detail: 'No login screen — open by design (local dev).', status: 'No auth', ok: false },
                    { name: 'Loki', detail: 'No dashboard of its own — browse logs via Grafana Explore.', status: 'N/A', ok: false },
                  ].map((s) => (
                    <div key={s.name} className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                      <div>
                        <div className="text-sm font-bold text-white">{s.name}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{s.detail}</div>
                      </div>
                      <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase ${s.ok ? 'bg-green-500/10 text-green-500' : 'bg-slate-500/10 text-slate-400'}`}>
                        {s.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {user.isAdmin && (
                <div className="pt-6 border-t border-slate-700">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="text-lg font-bold text-white">Invites</h4>
                    <button
                      onClick={() => mintInvite.mutate()}
                      disabled={mintInvite.isPending}
                      className="text-xs font-bold px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {mintInvite.isPending ? 'Generating...' : 'Generate Invite'}
                    </button>
                  </div>
                  <p className="text-xs text-slate-400 mb-4">
                    This platform is invite-only. Share an unused code with anyone you want to give an account.
                  </p>
                  <div className="space-y-2">
                    {invites.length === 0 && (
                      <div className="text-sm text-slate-500 italic">No invites generated yet.</div>
                    )}
                    {[...invites].reverse().map((inv: any) => (
                      <div key={inv.id} className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                        <div>
                          <div className="text-sm font-mono font-bold text-white">{inv.code}</div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {inv.usedBy ? `Used ${new Date(inv.usedAt).toLocaleDateString()}` : `Created ${new Date(inv.createdAt).toLocaleDateString()}`}
                          </div>
                        </div>
                        <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase ${inv.usedBy ? 'bg-slate-500/10 text-slate-400' : 'bg-green-500/10 text-green-500'}`}>
                          {inv.usedBy ? 'Used' : 'Unused'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
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
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl">
            <h3 className="text-2xl font-bold mb-2">Authorise this key</h3>
            <p className="text-sm text-slate-400 mb-6">
              Run this on the machine, then start provisioning. This is a public key — it grants
              access <em>to</em> that machine and is safe to paste anywhere.
            </p>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 mb-3">
              <code className="text-[11px] text-slate-300 font-mono break-all leading-relaxed">
                mkdir -p ~/.ssh &amp;&amp; echo '{pendingKey.publicKey}' &gt;&gt; ~/.ssh/authorized_keys
              </code>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(`mkdir -p ~/.ssh && echo '${pendingKey.publicKey}' >> ~/.ssh/authorized_keys`)}
              className="text-[11px] text-slate-500 hover:text-white transition-colors mb-6"
            >
              Copy command
            </button>

            <div className="bg-slate-900/50 border border-slate-700/50 rounded-2xl p-4 mb-8 flex items-start gap-3">
              <Shield className="text-blue-400 flex-shrink-0 mt-0.5" size={16} />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                The matching private key was generated on the platform and never sent to your
                browser. It is stored encrypted and used only to install k3s and, if you destroy
                the cluster, to remove it.
              </p>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setPendingKey(null)}
                className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 transition-all text-sm font-bold"
              >
                Later
              </button>
              <button
                onClick={() => startAwaitingCluster.mutate(pendingKey.id)}
                disabled={startAwaitingCluster.isPending}
                className="flex-1 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 transition-all text-sm font-bold flex items-center justify-center gap-2"
              >
                {startAwaitingCluster.isPending ? <Loader2 className="animate-spin" size={16} /> : "I've added it — start provisioning"}
              </button>
            </div>
            {startAwaitingCluster.isError && (
              <p className="text-[11px] text-red-400 mt-3">
                {(startAwaitingCluster.error as any)?.response?.data?.error ?? 'Could not start provisioning.'}
              </p>
            )}
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
