import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { io } from 'socket.io-client';
import { AnsiText } from './components/AnsiText.js';
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, BellRing, Blocks, Box, Check, ChevronDown, ChevronRight, ChevronUp, Cloud, Cpu, Database, ExternalLink, FileText, GitBranch, HardDrive, Key, Layers, LayoutGrid, Loader2, Network, Package, Plus, Puzzle, RefreshCw, Server, Settings, Shield, FlaskConical, Terminal, Timer, Trash2, Trees, X, Zap } from 'lucide-react';
import TemporalPanel from './TemporalPanel.js';
import ServicesPanel from './ServicesPanel.js';
import Login from './components/Login.js';
import CloudAccounts from './components/CloudAccounts.js';
import Projects from './components/Projects.js';
import ClusterWizard from './components/ClusterWizard.js';
import GameServerSettings from './components/GameServerSettings.js';
import VpsCatalog from './components/VpsCatalog.js';
import Lab from './components/Lab';
import Grove from './components/Grove.js';
import MeshDevices from './components/MeshDevices.js';
import Workspace from './components/Workspace.js';
import TreesView from './components/Trees.js';
import Personas from './components/Personas.js';
import { Koala } from './components/Koala.js';

const API_BASE = (import.meta.env?.VITE_API_BASE as string) || 'http://localhost:3001/api';
const SOCKET_URL = (import.meta.env?.VITE_SOCKET_URL as string) || 'http://localhost:3001';

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
 * Mirrors APP_TYPES in apps/backend/src/lib/app-catalog.ts — the frontend does not import backend
 * modules, so this is the one copy on this side rather than the two inline unions it replaced.
 */
type AppType =
  | 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik' | 'vllm'
  | 'tabbyapi' | 'openwebui' | 'hermes' | 'gitapp' | 'palworld' | 'jellyfin' | 'plex' | 'navidrome'
  | 'kavita' | 'immich' | 'papra' | 'homeassistant' | 'searxng' | 'crawl4ai' | 'qdrant' | 'minio'
  | 'quickwit' | 'tei' | 'verdaccio';

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
  palworld: {
    // Game server: native only. It has no Helm chart, and the wizard's Helm path would fall
    // through to Odoo (see the submit handler's strategy note below).
    helm: { webRepo: 'thijsvanloef/palworld-server-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'thijsvanloef/palworld-server-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  jellyfin: {
    helm: { webRepo: 'jellyfin/jellyfin', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'jellyfin/jellyfin', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  plex: {
    helm: { webRepo: 'plexinc/pms-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'plexinc/pms-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  navidrome: {
    helm: { webRepo: 'deluan/navidrome', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'deluan/navidrome', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  kavita: {
    helm: { webRepo: 'ghcr.io/kareadita/kavita', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/kareadita/kavita', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  immich: {
    helm: { webRepo: 'ghcr.io/immich-app/immich-server', webTag: 'release', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/immich-app/immich-server', webTag: 'release', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  searxng: {
    helm: { webRepo: 'searxng/searxng', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'searxng/searxng', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  crawl4ai: {
    helm: { webRepo: 'unclecode/crawl4ai', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'unclecode/crawl4ai', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  papra: {
    helm: { webRepo: 'ghcr.io/papra-hq/papra', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/papra-hq/papra', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  homeassistant: {
    helm: { webRepo: 'ghcr.io/home-assistant/home-assistant', webTag: 'stable', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/home-assistant/home-assistant', webTag: 'stable', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
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
  },
  vllm: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'vllm/vllm-openai', webTag: 'v0.7.2', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  tabbyapi: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/theroyallab/tabbyapi', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  openwebui: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/open-webui/open-webui', webTag: 'main', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  hermes: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'nousresearch/hermes-agent', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  }
};

// App types that require a GPU-enabled cluster (attached to the shared, GPU-capable
// management cluster — see backend ProvisionClusterActivity). Extend this as more GPU-backed
// LLM engines are added (e.g. future TGI/Ollama support).
const GPU_ONLY_APP_TYPES = new Set(['vllm', 'tabbyapi']);
// App types with no HTTP surface at all. The whole exposure story here is Traefik +
// localtunnel over HTTP, so offering it for a UDP game server produces a working tunnel to
// nothing. Also suppresses the clickable app link, whose url is a meaningless placeholder.
const NO_WEB_UI_APP_TYPES = new Set(['palworld']);

/**
 * Colour for a deployment's status pill.
 *
 * Every status used to render in the same blue, so `failed` and `running` were distinguishable only
 * by reading the word — which defeats the point of a status pill in a list. `unhealthy` gets amber
 * rather than red on purpose: the deploy worked, and colouring it like a failed deploy sends people
 * to the wrong logs.
 */
const deployStatusClass = (status: string) => (
  status === 'running' ? 'bg-green-500/10 text-green-400'
  : status === 'unhealthy' ? 'bg-amber-500/10 text-amber-400'
  : status === 'failed' ? 'bg-red-500/10 text-red-400'
  : status === 'deploying' || status === 'destroying' ? 'bg-yellow-500/10 text-yellow-400'
  : 'bg-slate-500/10 text-slate-400'
);

// TabbyAPI's tool-call parsers (endpoints/OAI/utils/toolcall_formats/*.py) — 'harmony' is
// documented as equivalent to setting the separate `harmony: true` config flag, so it's passed
// through as a plain tool_format value rather than needing special-casing.
const TABBY_TOOL_FORMATS = ['mistral', 'mistral_old', 'qwen3_coder', 'gemma4', 'glm4_5', 'minimax_m2', 'harmony'];

function App() {
  const queryClient = useQueryClient();
  // Open by default: collapsed, a first-time user sees two items and no way to tell that ten
  // more exist. Folding the infrastructure away is about hierarchy, not about hiding it.
  const [forestOpen, setForestOpen] = useState(true);
  /** A conversation to open with a message already queued. Cleared once Chat has sent it. */
  const [handoff, setHandoff] = useState<{ branchId: string; prompt: string } | undefined>(undefined);
  const [view, setView] = useState<'clusters' | 'apps' | 'projects' | 'nginx' | 'temporal' | 'services' | 'settings' | 'accounts' | 'vps-catalog' | 'mesh' | 'chat' | 'board' | 'lab' | 'trees' | 'personas' | 'grove'>('clusters');
  const [user, setUser] = useState<any>(
    import.meta.env?.MODE === 'test' || import.meta.env?.VITE_IS_E2E === 'true' || window.location.port === '5174'
      ? { id: 'test-user-id', email: 'test@example.com', createdAt: new Date().toISOString() }
      : null
  );
  const [authLoading, setAuthLoading] = useState(
    import.meta.env?.MODE !== 'test' && import.meta.env?.VITE_IS_E2E !== 'true' && window.location.port !== '5174'
  );
  const [editorContent, setEditorContent] = useState('');
  const [showClusterModal, setShowClusterModal] = useState(false);
  /** A bring-your-own cluster waiting for its generated public key to be authorised. */
  const [pendingKey, setPendingKey] = useState<{ id: string; publicKey: string } | null>(null);
  /** Set by the VPS Catalog's Deploy button so the wizard opens on that exact plan and location. */
  const [wizardPreset, setWizardPreset] = useState<{ provider: string; serverType?: string; location?: string } | undefined>(undefined);
  const [showAppModal, setShowAppModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState<{ type: 'cluster' | 'app', id: string } | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState<{ type: 'cluster' | 'app', id: string, name: string, isAbort?: boolean } | null>(null);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<any[]>([]);
  
  const [logTab, setLogTab] = useState<'general' | 'provision' | 'helm' | 'app' | 'diagnostics' | 'modules' | 'storage'>('general');
  const [storageInputs, setStorageInputs] = useState<Record<string, string>>({});
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
  // Schema-driven settings for game servers, edited in the Config tab. Seeded from the
  // deployment record when the tab opens (see the effect that hydrates configInputs).
  const [gameSettings, setGameSettings] = useState<Record<string, string>>({});
  const [exposurePathInput, setExposurePathInput] = useState('');
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [socketLogs, setSocketLogs] = useState<string>('');
  const [kubeLogs, setKubeLogs] = useState<string>('');
  const [lastLogAt, setLastLogAt] = useState<number | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<any>(null);
  const activeLogRoomRef = useRef<string | null>(null);
  const activeKubePodRef = useRef<{ id: string; podName: string; namespace: string } | null>(null);
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
        setUser((prev: any) => ({
          ...prev,
          twoFactorEnabled: data.twoFactorEnabled,
          twoFactorPhone: data.twoFactorPhone,
          twoFactorPreferredMethod: data.twoFactorPreferredMethod,
        }));
      }
    } catch (err) {
      console.error('Failed to update 2FA settings', err);
    }
  };

  // Unified Wizard State
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState({
    name: 'Odoo-Production',
    clusterId: '',
    appType: 'odoo' as AppType,
    strategy: 'native' as 'helm' | 'native',
    odooRepo: 'library/odoo',
    odooTag: '18.0',
    pgRepo: 'library/postgres',
    pgTag: '16.4',
    modules: [] as string[],
    vpnEnabled: false,
    vpnProtocol: 'wireguard' as 'wireguard' | 'openvpn',
    vpnConfig: '',
    vpnDedicatedIp: '',
    vllmMaxModelLen: '',
    vllmGpuMemUtil: '',
    vllmExtraArgs: '',
    vllmToolCallingEnabled: false,
    vllmToolCallParser: '',
    vllmServedModelName: '',
    vllmMaxNumSeqs: '',
    vllmDtype: '',
    vllmEnablePrefixCaching: false,
    tabbyModel: 'turboderp/Qwen3.6-27B-exl3',
    tabbyRevision: '',
    tabbyGpuCount: '2',
    tabbyHfToken: '',
    tabbyImageTag: 'latest',
    tabbyCacheMode: 'Q8',
    tabbyMaxSeqLen: '32768',
    tabbyMaxBatchSize: '',
    tabbyReasoning: true,
    tabbyToolFormat: 'qwen3_coder',
    tabbyInlineModelLoading: false,
    tabbyDisableAuth: true,
    tabbyMemoryLimit: '',
    tabbyShmSize: '',
    tabbyCpuLimit: '10',
    tabbyExtraEnv: '',
    openWebuiTargetId: '',
    hermesTargetId: '',
    webuiEnableWebSearch: true,
    webuiWebSearchEngine: 'duckduckgo',
    webuiWebSearchApiKey: '',
    palworldPlayers: '16'
  });
  const [showVllmAdvanced, setShowVllmAdvanced] = useState(false);
  const [showTabbyAdvanced, setShowTabbyAdvanced] = useState(false);

  const { data: clusters = [] } = useQuery({ queryKey: ['clusters'], queryFn: () => axios.get(`${API_BASE}/clusters`).then(res => res.data), refetchInterval: 3000 });
  const { data: deployments = [] } = useQuery({ queryKey: ['deployments'], queryFn: () => axios.get(`${API_BASE}/deployments`).then(res => res.data), refetchInterval: 3000 });
  const { data: credentialsData } = useQuery({ queryKey: ['credentials'], queryFn: () => axios.get(`${API_BASE}/credentials`).then(res => res.data) });
  const { data: invites = [] } = useQuery({ queryKey: ['invites'], queryFn: () => axios.get(`${API_BASE}/admin/invites`).then(res => res.data), enabled: !!user?.isAdmin });
  const mintInvite = useMutation({
    mutationFn: () => axios.post(`${API_BASE}/admin/invites`, {}).then(res => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
  });

  const hasHfAccount = credentialsData?.providers?.some((p: any) => p.provider === 'huggingface' && p.configured);
  const currentDeployment = showLogModal?.type === 'app' ? deployments.find((d: any) => d.id === showLogModal.id) : null;
  const currentCluster = showLogModal?.type === 'cluster' ? clusters.find((c: any) => c.id === showLogModal.id) : null;

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

  const { data: clusterGpuStatus, isLoading: loadingClusterGpu } = useQuery({
    queryKey: ['cluster-gpu', expandedCluster],
    queryFn: () => axios.get(`${API_BASE}/clusters/${expandedCluster}/gpu-status`).then(res => res.data),
    enabled: !!expandedCluster,
    refetchInterval: 5000
  });

  const { data: podResponse, dataUpdatedAt: podsCheckedAt } = useQuery({
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

  // Which image tags the running TabbyAPI image actually supports — fetched live rather than
  // hardcoded, since ghcr.io/theroyallab/tabbyapi's published tags can change upstream (new
  // CUDA variants added/dropped) independent of this codebase. Local tags come from the host
  // Docker cache (deploys instantly, no pull) and are merged with what's downloadable from the
  // registry so the picker shows both, distinguishing which is which.
  const TABBY_IMAGE_REPO = 'ghcr.io/theroyallab/tabbyapi';
  const tabbyImagePickerOpen = (showAppModal && wizardStep === 4 && wizardData.appType === 'tabbyapi') || (!!currentDeployment && currentDeployment.appType === 'tabbyapi');
  const { data: tabbyRemoteTags = [], isLoading: loadingTabbyImageTags } = useQuery({ queryKey: ['tags', TABBY_IMAGE_REPO], queryFn: () => axios.get(`${API_BASE}/registry/tags?repo=${TABBY_IMAGE_REPO}`).then(res => res.data), enabled: tabbyImagePickerOpen });
  const { data: tabbyLocalTags = [] } = useQuery({ queryKey: ['local-tags', TABBY_IMAGE_REPO], queryFn: () => axios.get(`${API_BASE}/registry/local-tags?repo=${TABBY_IMAGE_REPO}`).then(res => res.data), enabled: tabbyImagePickerOpen });
  const TABBY_IMAGE_TAG_HINTS: Record<string, string> = { latest: 'CUDA 12.8', cu13: 'CUDA 13.x' };
  const tabbyImageTagOptions = Array.from(new Set([...(tabbyRemoteTags as string[]), ...(tabbyLocalTags as string[])])).map((tag: string) => ({
    tag,
    cached: (tabbyLocalTags as string[]).includes(tag),
    label: TABBY_IMAGE_TAG_HINTS[tag] ? `${tag} — ${TABBY_IMAGE_TAG_HINTS[tag]}` : tag,
  }));

  // Debounced so this doesn't fire on every keystroke while typing a model ID or context length
  // — HuggingFace's API is cheap but there's no reason to hit it on every digit.
  const [debouncedTabbyModel, setDebouncedTabbyModel] = useState('');
  const [debouncedTabbyRevision, setDebouncedTabbyRevision] = useState('');
  const [debouncedTabbyMaxSeqLen, setDebouncedTabbyMaxSeqLen] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedTabbyModel(wizardData.tabbyModel);
      setDebouncedTabbyRevision(wizardData.tabbyRevision);
      setDebouncedTabbyMaxSeqLen(wizardData.tabbyMaxSeqLen);
    }, 500);
    return () => clearTimeout(t);
  }, [wizardData.tabbyModel, wizardData.tabbyRevision, wizardData.tabbyMaxSeqLen]);
  const { data: tabbyModelSize, isFetching: loadingTabbyModelSize, isError: tabbyModelSizeError } = useQuery({
    queryKey: ['hf-size', debouncedTabbyModel, debouncedTabbyRevision, debouncedTabbyMaxSeqLen, wizardData.tabbyCacheMode, wizardData.tabbyGpuCount],
    queryFn: () => axios.get(`${API_BASE}/models/hf-size`, { params: {
      repo: debouncedTabbyModel,
      revision: debouncedTabbyRevision || undefined,
      maxSeqLen: debouncedTabbyMaxSeqLen || undefined,
      cacheMode: wizardData.tabbyCacheMode || undefined,
      gpuCount: wizardData.tabbyGpuCount,
    } }).then(res => res.data),
    enabled: showAppModal && wizardStep === 4 && wizardData.appType === 'tabbyapi' && !!debouncedTabbyModel,
    retry: false,
  });

  // Same VRAM-estimate treatment as TabbyAPI above, adapted for vLLM's own fields: no revision
  // concept (vLLM doesn't split quants across HF branches the way EXL2/EXL3 repos do), and dtype
  // instead of cache_mode — mapped to 'FP16' (2 bytes/element) for every realistic vLLM dtype
  // (auto/half/float16/bfloat16 are all 2 bytes; float32 is rare enough for LLM serving that this
  // doesn't special-case it separately, same caveat-labeled estimate as the TabbyAPI side).
  const [debouncedVllmModel, setDebouncedVllmModel] = useState('');
  const [debouncedVllmMaxModelLen, setDebouncedVllmMaxModelLen] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedVllmModel(wizardData.odooRepo);
      setDebouncedVllmMaxModelLen(wizardData.vllmMaxModelLen);
    }, 500);
    return () => clearTimeout(t);
  }, [wizardData.odooRepo, wizardData.vllmMaxModelLen]);
  const { data: vllmModelSize, isFetching: loadingVllmModelSize, isError: vllmModelSizeError } = useQuery({
    queryKey: ['hf-size', debouncedVllmModel, debouncedVllmMaxModelLen, wizardData.odooTag],
    queryFn: () => axios.get(`${API_BASE}/models/hf-size`, { params: {
      repo: debouncedVllmModel,
      maxSeqLen: debouncedVllmMaxModelLen || undefined,
      cacheMode: 'FP16',
      gpuCount: wizardData.odooTag && wizardData.odooTag !== '0' ? wizardData.odooTag : '1',
    } }).then(res => res.data),
    enabled: showAppModal && wizardStep === 4 && wizardData.appType === 'vllm' && !!debouncedVllmModel,
    retry: false,
  });

  // Shared model-search picker for both vLLM and TabbyAPI wizard steps — replaces what used to
  // be a static hardcoded list of 4-5 models with a live HuggingFace search. An empty query
  // still returns results (sorted by downloads), so it doubles as a "trending models" list.
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [debouncedModelSearchQuery, setDebouncedModelSearchQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedModelSearchQuery(modelSearchQuery), 400);
    return () => clearTimeout(t);
  }, [modelSearchQuery]);
  const { data: modelSearchResults = [], isFetching: loadingModelSearch } = useQuery({
    queryKey: ['model-search', wizardData.appType, debouncedModelSearchQuery],
    queryFn: () => axios.get(`${API_BASE}/models/search`, { params: { q: debouncedModelSearchQuery, appType: wizardData.appType } }).then(res => res.data),
    enabled: showAppModal && wizardStep === 3 && (wizardData.appType === 'vllm' || wizardData.appType === 'tabbyapi'),
    staleTime: 30000,
  });
  // Only relevant for TabbyAPI — EXL2/EXL3 quants split their bpw variants across branches of
  // one repo, so picking a model isn't enough on its own; see getHfModelBranches's own comment.
  const { data: tabbyModelBranches = [], isFetching: loadingTabbyModelBranches } = useQuery({
    queryKey: ['hf-branches', wizardData.tabbyModel],
    queryFn: () => axios.get(`${API_BASE}/models/hf-branches`, { params: { repo: wizardData.tabbyModel } }).then(res => res.data),
    enabled: showAppModal && wizardStep === 3 && wizardData.appType === 'tabbyapi' && !!wizardData.tabbyModel,
    staleTime: 30000,
  });
  // Defaults to the highest-bpw (best quality) branch the moment the list loads, rather than
  // leaving Revision blank — TabbyAPI's downloader needs a real branch, and "main" on an
  // EXL2/EXL3 repo is often just a README pointer with no actual weights in it. Still fully
  // overridable via the picker below or the free-text Revision field on the next step.
  useEffect(() => {
    if (tabbyModelBranches.length > 0 && !wizardData.tabbyRevision) {
      setWizardData(prev => ({ ...prev, tabbyRevision: tabbyModelBranches[0] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabbyModelBranches]);
  const renderModelSearchPicker = (selectedModel: string, onSelect: (id: string) => void, placeholder = 'e.g. llama, mistral, qwen...') => (
    <div>
      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Search Hugging Face Models</label>
      <input
        value={modelSearchQuery}
        onChange={e => setModelSearchQuery(e.target.value)}
        className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm mb-2"
        placeholder={placeholder}
      />
      <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto custom-scrollbar pr-1">
        {loadingModelSearch ? (
          <div className="flex items-center gap-2 text-slate-500 text-xs py-3"><Loader2 size={14} className="animate-spin" /> Searching Hugging Face...</div>
        ) : modelSearchResults.length > 0 ? modelSearchResults.map((m: any) => (
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

  /**
   * What the resource ceilings resolve to when left blank.
   *
   * Shown as placeholders, never written into the fields: an empty box here means "size this for
   * me", and pre-filling it would turn a computed default into an explicit choice that then
   * overrides the plan forever.
   */
  const { data: resourcePlan } = useQuery<{
    applicable: boolean; memoryLimit?: string; shmSize?: string; cpuLimit?: string;
    basis?: string; refusal?: string;
  }>({
    queryKey: ['resource-plan', currentDeployment?.id],
    queryFn: () => axios.get(`${API_BASE}/deployments/${currentDeployment?.id}/resource-plan`).then(r => r.data),
    // Only for the app that is open, and only where the plan applies — the endpoint answers
    // `applicable: false` for anything that is not TabbyAPI rather than guessing.
    enabled: !!currentDeployment && currentDeployment?.appType === 'tabbyapi',
    staleTime: 60_000,
  });

  const { data: initialLogs } = useQuery({
    queryKey: ['logs', showLogModal?.type, showLogModal?.id], 
    queryFn: () => axios.get(`${API_BASE}/logs/${showLogModal?.type}/${showLogModal?.id}`).then(res => res.data), 
    enabled: !!showLogModal && (logTab === 'provision' || (showLogModal.type === 'app' && currentDeployment?.status === 'failed' && logTab === 'general')) 
  });


  useEffect(() => {
    // withCredentials sends the session cookie with the handshake. The server now authenticates
    // sockets the same way it authenticates /api requests, and in dev the UI is a different origin
    // to the API, so without this the connection is rejected outright.
    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;
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
    socket.on('deployment-updated', () => {
        queryClient.invalidateQueries({ queryKey: ['deployments'] });
    });
    socket.on('reconnect', () => {
      if (activeLogRoomRef.current) {
        // Same clear as on first join — a reconnect replays history from scratch.
        setSocketLogs('');
        socket.emit('join-room', activeLogRoomRef.current);
      }
      if (activeKubePodRef.current) {
        const { id, podName, namespace } = activeKubePodRef.current;
        // The server always restarts the pod's log tail from scratch (kubectl logs --tail=100),
        // never a resume-from-where-we-left-off stream — without clearing here first, that
        // re-fetched history lands on top of whatever was already accumulated client-side and
        // shows up as the same lines repeating. Every backend restart or network blip triggers
        // this path, so it's not just a one-off.
        setKubeLogs('');
        setLastLogAt(null);
        socket.emit('join-kube-room', id);
        socket.emit('tail-pod', { resourceId: id, podName, namespace });
      }
    });
    return () => { socket.disconnect(); };
  }, [queryClient]);

  useEffect(() => {
    if (showLogModal && socketRef.current) {
      const socket = socketRef.current;
      activeLogRoomRef.current = showLogModal.id;
      /**
       * Cleared before joining, because the server now replays recent history on join.
       *
       * The same reason the pod tail clears: a replay landing on top of what was already
       * accumulated shows as the identical lines repeating, and every reconnect triggers it.
       */
      setSocketLogs('');
      socket.emit('join-room', showLogModal.id);
      socket.on('log', (chunk: string) => setSocketLogs(prev => prev + chunk));
      return () => {
        socket.emit('leave-room', showLogModal.id);
        activeLogRoomRef.current = null;
        socket.off('log');
      };
    }
  }, [showLogModal]);

  useEffect(() => {
    if (showLogModal?.type === 'app' && logTab === 'app' && pods.length > 0) {
      const exists = pods.some((p: any) => p?.metadata?.name === selectedPod);
      if (!selectedPod || !exists) {
        setSelectedPod(pods[0]?.metadata?.name || null);
        setKubeLogs('');
        setLastLogAt(null);
      }
    }
  }, [showLogModal, logTab, pods, selectedPod]);

  useEffect(() => {
    if (showLogModal?.type === 'app' && logTab === 'app' && selectedPod && socketRef.current) {
      const socket = socketRef.current;
      activeKubePodRef.current = { id: showLogModal.id, podName: selectedPod, namespace };
      socket.emit('join-kube-room', showLogModal.id);
      socket.emit('tail-pod', { resourceId: showLogModal.id, podName: selectedPod, namespace });
      socket.on('kube-log', (chunk: string) => { setKubeLogs(prev => prev + chunk); setLastLogAt(Date.now()); });
      return () => {
        socket.emit('leave-kube-room', showLogModal.id);
        activeKubePodRef.current = null;
        socket.off('kube-log');
      };
    }
  }, [showLogModal, logTab, selectedPod, namespace]);

  useEffect(() => {
    if (!showLogModal) {
      setSocketLogs('');
      setKubeLogs('');
      setLastLogAt(null);
    }
  }, [showLogModal]);

  useEffect(() => {
    // scrollIntoView scrolls both axes; skip for diagnostics so its horizontal
    // scroll position (browsing the wide kubectl table) isn't reset every poll.
    if (logTab === 'diagnostics') return;
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [socketLogs, kubeLogs, helmStatus, diagnostics, logTab]);

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
      case 'palworld':
        // Must match StorageAdapter.getSupportedVolumes on the backend — that's what actually
        // emits STORAGE_DATA for the construct.
        return ['data'];
      case 'jellyfin':
        return ['config', 'cache', 'media'];
      case 'plex':
        return ['config', 'media'];
      case 'navidrome':
        return ['data', 'music'];
      case 'kavita':
        return ['config', 'manga'];
      case 'immich':
        return ['library'];
      case 'papra':
        return ['data', 'media'];
      case 'homeassistant':
        return ['config'];
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
      // The stored map is already schema-complete (TemporalBridge resolves defaults on deploy),
      // so the editor renders real current values rather than blanks.
      setGameSettings({ ...(currentDeployment.appSettings || {}) });

      setConfigInputs({
        webRepo: currentDeployment.webRepo || '',
        webTag: currentDeployment.webTag || '',
        dbRepo: currentDeployment.dbRepo || '',
        dbTag: currentDeployment.dbTag || '',
        vllmModel: currentDeployment.vllmModel || '',
        vllmGpuCount: currentDeployment.vllmGpuCount !== undefined ? String(currentDeployment.vllmGpuCount) : '1',
        vllmGpuVendor: currentDeployment.vllmGpuVendor || 'nvidia',
        vllmHfToken: '', // never pre-fill a secret back into a form field
        vllmMaxModelLen: currentDeployment.vllmMaxModelLen !== undefined ? String(currentDeployment.vllmMaxModelLen) : '',
        vllmGpuMemUtil: currentDeployment.vllmGpuMemUtil !== undefined ? String(currentDeployment.vllmGpuMemUtil) : '',
        vllmExtraArgs: currentDeployment.vllmExtraArgs || '',
        vllmToolCallingEnabled: currentDeployment.vllmToolCallingEnabled || false,
        vllmToolCallParser: currentDeployment.vllmToolCallParser || '',
        vllmServedModelName: currentDeployment.vllmServedModelName || '',
        vllmMaxNumSeqs: currentDeployment.vllmMaxNumSeqs !== undefined ? String(currentDeployment.vllmMaxNumSeqs) : '',
        vllmDtype: currentDeployment.vllmDtype || '',
        vllmEnablePrefixCaching: currentDeployment.vllmEnablePrefixCaching || false,
        tabbyModel: currentDeployment.tabbyModel || '',
        tabbyRevision: currentDeployment.tabbyRevision || '',
        tabbyGpuCount: currentDeployment.tabbyGpuCount !== undefined ? String(currentDeployment.tabbyGpuCount) : '1',
        tabbyHfToken: '', // never pre-fill a secret back into a form field
        tabbyImageTag: currentDeployment.tabbyImageTag || 'latest',
        tabbyCacheMode: currentDeployment.tabbyCacheMode || '',
        tabbyMaxSeqLen: currentDeployment.tabbyMaxSeqLen !== undefined ? String(currentDeployment.tabbyMaxSeqLen) : '',
        tabbyMaxBatchSize: currentDeployment.tabbyMaxBatchSize !== undefined ? String(currentDeployment.tabbyMaxBatchSize) : '',
        tabbyReasoning: currentDeployment.tabbyReasoning || false,
        tabbyToolFormat: currentDeployment.tabbyToolFormat || '',
        tabbyInlineModelLoading: currentDeployment.tabbyInlineModelLoading || false,
        tabbyDisableAuth: currentDeployment.tabbyDisableAuth !== false,
        tabbyMemoryLimit: currentDeployment.tabbyMemoryLimit || '',
        tabbyShmSize: currentDeployment.tabbyShmSize || '',
        tabbyCpuLimit: currentDeployment.tabbyCpuLimit || '',
        tabbyExtraEnv: currentDeployment.tabbyExtraEnv || '',
        openWebuiTargetId: currentDeployment.openWebuiTargetId || '',
        hermesTargetId: currentDeployment.hermesTargetId || '',
        webuiEnableWebSearch: currentDeployment.webuiEnableWebSearch !== false,
        webuiWebSearchEngine: currentDeployment.webuiWebSearchEngine || 'duckduckgo',
        webuiWebSearchApiKey: '', // never pre-fill a secret back into a form field
      });
    }
  }, [currentDeployment?.id, logTab]);

  useEffect(() => {
    if (currentDeployment) {
      setExposurePathInput(currentDeployment.exposurePath || '');
    }
  }, [currentDeployment?.id]);

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

  const updateAppConfig = useMutation({
    mutationFn: ({ id, patch }: { id: string, patch: Record<string, any> }) => axios.patch(`${API_BASE}/deployments/${id}/config`, patch),
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

  // No separate "abort" mutation: DELETE /api/clusters/:id and /api/deployments/:id already
  // detect a still-provisioning/deploying resource server-side and abort it instead of trying to
  // destroy something that was never fully created — see index.ts's delete handlers. A dedicated
  // Abort button/mutation calling POST .../abort did the exact same thing through a second path,
  // which just meant two buttons for one operation.

  const exposeApp = useMutation({
    mutationFn: ({ id, mode }: { id: string, mode: 'public' | 'local' }) => axios.post(`${API_BASE}/deployments/${id}/expose`, { mode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    }
  });

  const unexposeApp = useMutation({
    mutationFn: ({ id, mode }: { id: string, mode: 'public' | 'local' }) => axios.post(`${API_BASE}/deployments/${id}/unexpose`, { mode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    }
  });

  const updateExposurePath = useMutation({
    mutationFn: ({ id, path }: { id: string, path: string }) => axios.patch(`${API_BASE}/deployments/${id}/exposure-path`, { path }),
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

  const isModelApp = (appType: string) => appType === 'vllm' || appType === 'tabbyapi';

  const nextStep = () => {
    const config = APP_DEFAULTS[wizardData.appType];
    if (wizardStep === 2) {
      setWizardStep(isModelApp(wizardData.appType) ? 3 : 4);
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
      setWizardStep(isModelApp(wizardData.appType) ? 3 : 2);
    } else if (wizardStep === 3) {
      setWizardStep(2);
    } else if (wizardStep === 6 && !config.hasDatabase) {
      setWizardStep(4);
    } else {
      setWizardStep(s => s - 1);
    }
  };

  const handleAppTypeChange = (newAppType: AppType) => {
    const config = APP_DEFAULTS[newAppType];
    const newStrategy = config.strategies.includes(wizardData.strategy) ? wizardData.strategy : config.strategies[0];
    const defaults = config[newStrategy];
    const capitalized = newAppType.charAt(0).toUpperCase() + newAppType.slice(1);

    setWizardData(prev => {
      const prevCapitalized = prev.appType.charAt(0).toUpperCase() + prev.appType.slice(1);
      const isDefaultName = prev.name === `${prevCapitalized}-Production`;
      // If the currently selected cluster no longer satisfies the new app type's GPU
      // requirement (either direction), clear it rather than leaving an invalid selection.
      const selectedCluster = clusters.find((c: any) => c.id === prev.clusterId);
      const stillValidCluster = !selectedCluster || !GPU_ONLY_APP_TYPES.has(newAppType) || selectedCluster.gpuEnabled;
      let nextClusterId = stillValidCluster ? prev.clusterId : '';
      // No selection yet (or it just got cleared above) and vLLM/TabbyAPI need a GPU cluster —
      // if there's only one to choose from, there's no real decision to make the user click
      // through, so pick it for them. Still overridable via the dropdown; only fires when
      // there's exactly one candidate, never when there's a real choice to make.
      if (GPU_ONLY_APP_TYPES.has(newAppType) && !nextClusterId) {
        const gpuClusters = clusters.filter((c: any) => c.status === 'healthy' && c.gpuEnabled);
        if (gpuClusters.length === 1) nextClusterId = gpuClusters[0].id;
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
      <aside className="w-64 bg-[var(--bark-800)] border-r border-[var(--bark-600)] p-5 flex flex-col shadow-xl z-20">
        <div className="flex items-center gap-2.5 mb-8">
          <Koala size={34} mood="idle" />
          <div className="leading-none">
            <h1 className="text-lg font-bold tracking-tight">NO WRINKLES</h1>
            <p className="text-[10px] text-[var(--leaf)] tracking-widest uppercase mt-0.5">smooth brained ops</p>
          </div>
        </div>

        <nav className="space-y-1 flex-1 overflow-y-auto">
          {/* Koala is the product; everything else is the infrastructure it runs on. Giving the
              harness top billing and folding ten operational tabs into one keeps that hierarchy
              legible instead of presenting eleven equal choices. */}
          <button
            onClick={() => setView('chat')}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${view === 'chat' ? 'bg-[var(--leaf-stem)] text-white' : 'text-slate-300 hover:bg-[var(--bark-700)]'}`}
          >
            <Koala size={20} mood={view === 'chat' ? 'happy' : 'idle'} /> Koala
          </button>

          {/* Indented under Koala rather than listed beside it: a tree is the scope conversations
              live in, so it belongs to the harness, not to the infrastructure below. */}
          {/* Grove is the one navigator: tree → branch → leaf, the shape the data already has.
              It sits above Trees and Koala because it subsumes both — those two stay only until it
              is at parity, and then they go. */}
          <button
            onClick={() => setView('grove')}
            className={`w-full flex items-center gap-2.5 pl-11 pr-3 py-2 rounded-xl text-[13px] transition-colors ${view === 'grove' ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`}
          >
            <LayoutGrid size={15} className="text-[var(--leaf)]" /> Grove
          </button>
          <button
            onClick={() => setView('trees')}
            className={`w-full flex items-center gap-2.5 pl-11 pr-3 py-2 rounded-xl text-[13px] transition-colors ${view === 'trees' ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`}
          >
            <Trees size={15} className="text-[var(--leaf)]" /> Trees
          </button>
          <button
            onClick={() => setView('personas')}
            className={`w-full flex items-center gap-2.5 pl-11 pr-3 py-2 rounded-xl text-[13px] transition-colors ${view === 'personas' ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`}
          >
            <Shield size={15} className="text-[var(--leaf)]" /> Personas
          </button>
          {/* Moved out of the Forest, where it sat two levels down inside a collapsible section
              whose open state was not persisted — collapsing Forest made it vanish entirely. It is
              where the harness is inspected and tuned, which is Koala's business, not the
              infrastructure's. */}
          <button
            onClick={() => setView('lab')}
            className={`w-full flex items-center gap-2.5 pl-11 pr-3 py-2 rounded-xl text-[13px] transition-colors ${view === 'lab' ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`}
          >
            <FlaskConical size={15} className="text-[var(--leaf)]" /> Lab
          </button>

          <button
            onClick={() => setForestOpen((o) => !o)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-[var(--bark-700)] transition-colors"
          >
            <Trees size={20} className="text-[var(--leaf)]" />
            <span className="flex-1 text-left">Forest</span>
            {forestOpen ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
          </button>

          {forestOpen && (
            <div className="ml-3 pl-3 border-l border-[var(--bark-600)] space-y-0.5">
              {FOREST_TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setView(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${view === tab.id ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`}
                >
                  <tab.icon size={15} /> {tab.label}
                </button>
              ))}
            </div>
          )}
        </nav>

        <button onClick={handleLogout} className="w-full mt-4 mb-4 flex items-center gap-3 px-3 py-2.5 text-red-400/80 hover:bg-red-500/10 rounded-xl transition-all cursor-pointer text-[13px] font-semibold">Log Out</button>
        <div className="pt-4 border-t border-[var(--bark-600)] flex items-center gap-2 text-slate-600 text-[10px] uppercase font-black tracking-widest"><Terminal size={13} /> <span>Local Ops Active</span></div>
      </aside>

      <main className="flex-1 p-10 overflow-y-auto relative">
        <div className="fixed top-6 right-6 z-[60] space-y-3">
          {notifications.map(n => (<div key={n.nid} className={`bg-slate-800 border-l-4 ${n.outOfBand ? 'border-yellow-500' : 'border-green-500'} p-4 rounded-lg shadow-2xl flex items-center gap-4 min-w-[300px] animate-in slide-in-from-right`}><BellRing className={n.outOfBand ? 'text-yellow-500' : 'text-green-500'} size={20} /><div><div className="text-[10px] font-black uppercase text-slate-500 tracking-tighter">{n.outOfBand ? 'External Event' : 'System Event'}</div><div className="text-sm font-bold">{n.name} {n.outOfBand ? 'Deleted Externally' : 'Destroyed'}</div></div></div>))}
        </div>

        {view === 'clusters' && (
          <section>
            <header className="flex justify-between items-center mb-10"><div><h2 className="text-3xl font-bold">Infrastructures</h2><p className="text-slate-400">Manage your Kubernetes fleet.</p></div><button onClick={() => setShowClusterModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105"><Plus size={20} /> Provision Cluster</button></header>
            <div className="grid grid-cols-1 gap-8 max-w-5xl">{clusters.map((c: any) => (
                <div key={c.id} className={c.isSystem
                  ? "bg-gradient-to-br from-purple-950/60 via-slate-800 to-slate-800 rounded-3xl border-2 border-purple-500/40 overflow-hidden shadow-lg shadow-purple-950/30 transition-all"
                  : "bg-slate-800 rounded-3xl border border-slate-700 overflow-hidden shadow-sm transition-all hover:border-slate-500"
                }>
                  <div className="p-8">
                    <div className="flex justify-between items-center mb-6">
                      <div className="flex items-center gap-4"><div className={`p-3 rounded-2xl ${c.isSystem ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/10 text-blue-500'}`}>{c.isSystem ? <Shield size={28} /> : <Cloud size={28} />}</div><div><h4 className="font-bold text-2xl flex items-center gap-2">{c.name}{c.isSystem && (<span className="text-[9px] font-black px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-widest">System</span>)}</h4><span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">{c.provider} • {c.isSystem ? 'always-on management cluster · read-only' : c.id.slice(0,8)}</span></div></div>
                      <div className="flex items-center gap-3">
                        <span className={`text-[10px] font-bold px-4 py-1.5 rounded-full uppercase flex items-center gap-2 ${c.status === 'healthy' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500 animate-pulse'}`}>
                          <div className={`w-2 h-2 rounded-full ${c.status === 'healthy' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                          {c.status}
                        </span>
                        {!c.isSystem && (
                          <button onClick={() => openDashboard('cluster', c.id)} className="p-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-slate-300 transition-colors">
                            <FileText size={20} />
                          </button>
                        )}
                        {c.isSystem ? (
                          <span title="The system management cluster can't be modified from here" className="p-2.5 bg-slate-800 rounded-xl text-slate-600 cursor-not-allowed">
                            <Shield size={20} />
                          </span>
                        ) : (
                          <button onClick={() => setConfirmDestroy({ type: 'cluster', id: c.id, name: c.name, isAbort: c.status === 'provisioning' })} className="p-2.5 bg-slate-700 hover:bg-red-600 rounded-xl text-red-400 hover:text-white transition-all">
                            <Trash2 size={20} />
                          </button>
                        )}
                      </div>
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
                           <div>
                               <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Zap size={12} className="text-amber-400" /> GPU Acceleration & Availability</h5>
                               {loadingClusterGpu ? (
                                 <div className="text-center py-4"><Loader2 className="animate-spin text-slate-600 mx-auto" size={20} /></div>
                               ) : clusterGpuStatus ? (
                                 <div className="bg-slate-900/50 rounded-2xl border border-slate-700/50 p-5 space-y-4">
                                   <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
                                     <div className="flex items-center gap-3">
                                       <div className={`p-2.5 rounded-xl ${clusterGpuStatus.hasGpu || clusterGpuStatus.passthroughEnabled ? 'bg-amber-500/10 text-amber-400' : 'bg-slate-800 text-slate-500'}`}>
                                         <Zap size={20} />
                                       </div>
                                       <div>
                                         <div className="font-bold text-sm text-slate-200">
                                           {clusterGpuStatus.vendor !== 'none' ? `${clusterGpuStatus.vendor} GPU Acceleration` : 'GPU Status'}
                                         </div>
                                         <div className="text-[11px] text-slate-400">
                                           Passthrough: <span className="font-semibold text-slate-300">{c.gpuEnabled || clusterGpuStatus.passthroughEnabled ? 'Enabled' : 'Disabled'}</span>
                                         </div>
                                       </div>
                                     </div>
                                     <div className="flex items-center gap-2">
                                       {clusterGpuStatus.totalCapacity > 0 ? (
                                         <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase flex items-center gap-1.5 ${clusterGpuStatus.availableGpus > 0 ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                                           <div className={`w-1.5 h-1.5 rounded-full ${clusterGpuStatus.availableGpus > 0 ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                           {clusterGpuStatus.availableGpus} / {clusterGpuStatus.totalAllocatable} GPU Available
                                         </span>
                                       ) : (c.gpuEnabled || clusterGpuStatus.passthroughEnabled) ? (
                                         <span className="text-[10px] font-bold px-3 py-1 rounded-full uppercase bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 flex items-center gap-1.5">
                                           <AlertTriangle size={12} />
                                           No GPU Detected on Host Node
                                         </span>
                                       ) : (
                                         <span className="text-[10px] font-bold px-3 py-1 rounded-full uppercase bg-slate-800 text-slate-400 border border-slate-700">
                                           Passthrough Disabled
                                         </span>
                                       )}
                                     </div>
                                   </div>

                                   <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                     <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                       <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Total Capacity</div>
                                       <div className="text-lg font-bold text-slate-100 mt-0.5">{clusterGpuStatus.totalCapacity} GPU</div>
                                     </div>
                                     <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                       <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Allocatable</div>
                                       <div className="text-lg font-bold text-slate-100 mt-0.5">{clusterGpuStatus.totalAllocatable} GPU</div>
                                     </div>
                                     <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                       <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Allocated Workloads</div>
                                       <div className="text-lg font-bold text-amber-400 mt-0.5">{clusterGpuStatus.totalAllocated} GPU</div>
                                     </div>
                                     <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                       <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Available</div>
                                       <div className={`text-lg font-bold mt-0.5 ${clusterGpuStatus.availableGpus > 0 ? 'text-green-400' : 'text-slate-400'}`}>{clusterGpuStatus.availableGpus} GPU</div>
                                     </div>
                                   </div>

                                   {clusterGpuStatus.devicePlugins?.length > 0 && (
                                     <div className="pt-2 border-t border-slate-800/80">
                                       <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Device Plugin Status</div>
                                       <div className="flex flex-wrap gap-2">
                                         {clusterGpuStatus.devicePlugins.map((dp: any) => (
                                           <div key={dp.name} className="bg-slate-800 p-2.5 rounded-lg border border-slate-700/60 flex items-center justify-between text-xs w-full">
                                             <span className="font-mono text-slate-300 text-[11px]">{dp.name}</span>
                                             <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${dp.status === 'active' ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
                                               {dp.status === 'active' ? 'Active' : 'Degraded'} ({dp.readyPods}/{dp.desiredPods} pods ready)
                                             </span>
                                           </div>
                                         ))}
                                       </div>
                                     </div>
                                   )}

                                   {clusterGpuStatus.gpuPods?.length > 0 && (
                                     <div className="pt-2 border-t border-slate-800/80">
                                       <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Active GPU Workloads</div>
                                       <div className="space-y-1.5">
                                         {clusterGpuStatus.gpuPods.map((gp: any) => (
                                           <div key={gp.name} className="bg-slate-800/70 px-3 py-2 rounded-lg border border-slate-700/50 flex justify-between items-center text-xs">
                                             <div className="flex items-center gap-2">
                                               <span className="text-amber-400 font-bold">{gp.gpus} GPU</span>
                                               <span className="font-bold text-slate-200">{gp.name}</span>
                                               <span className="text-[10px] text-slate-500 font-mono">({gp.namespace})</span>
                                             </div>
                                             <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${gp.status === 'Running' ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400 animate-pulse'}`}>{gp.status}</span>
                                           </div>
                                         ))}
                                       </div>
                                     </div>
                                   )}
                                 </div>
                               ) : <div className="text-slate-600 text-xs italic">GPU status unavailable.</div>}
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
            <header className="flex justify-between items-center mb-10"><div><h2 className="text-3xl font-bold">Applications</h2><p className="text-slate-400">Deploy application instances.</p></div><button onClick={() => { setShowAppModal(true); setWizardStep(1); setWizardData({ name: 'Odoo-Production', clusterId: '', appType: 'odoo', strategy: 'native', odooRepo: 'library/odoo', odooTag: '18.0', pgRepo: 'library/postgres', pgTag: '16.4', modules: [], vpnEnabled: false, vpnProtocol: 'wireguard', vpnConfig: '', vpnDedicatedIp: '', vllmMaxModelLen: '', vllmGpuMemUtil: '', vllmExtraArgs: '', vllmToolCallingEnabled: false, vllmToolCallParser: '', vllmServedModelName: '', vllmMaxNumSeqs: '', vllmDtype: '', vllmEnablePrefixCaching: false, tabbyModel: 'turboderp/Qwen3.6-27B-exl3', tabbyRevision: '', tabbyGpuCount: '2', tabbyHfToken: '', tabbyImageTag: 'latest', tabbyCacheMode: 'Q8', tabbyMaxSeqLen: '32768', tabbyMaxBatchSize: '', tabbyReasoning: true, tabbyToolFormat: 'qwen3_coder', tabbyInlineModelLoading: false, tabbyDisableAuth: true, tabbyMemoryLimit: '', tabbyShmSize: '', tabbyCpuLimit: '10', tabbyExtraEnv: '', openWebuiTargetId: '', hermesTargetId: '', webuiEnableWebSearch: true, webuiWebSearchEngine: 'duckduckgo', webuiWebSearchApiKey: '', palworldPlayers: '16' }); setShowVllmAdvanced(false); setShowTabbyAdvanced(false); }} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105"><Plus size={20} /> Deploy App</button></header>
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
                            {a.status === 'running' && !NO_WEB_UI_APP_TYPES.has(a.appType || '') ? (
                              <a href={a.url} target="_blank" rel="noreferrer" className="group flex items-center gap-2 w-fit">
                                <span className="font-bold text-xl text-blue-400 group-hover:text-blue-300 transition-colors underline decoration-blue-500/30 underline-offset-4">{a.name}</span>
                                <ExternalLink size={16} className="text-slate-600 group-hover:text-blue-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                              </a>
                            ) : (
                              <span className="font-bold text-xl text-slate-500">{a.name}</span>
                            )}
                            {a.isExposed && a.exposureUrl && (
                              <a href={a.exposureUrl + (a.exposurePath || '')} target="_blank" rel="noreferrer" className="group flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors w-fit font-semibold mt-1">
                                <span>Exposed: {a.exposureUrl}{a.exposurePath || ''}</span>
                                <ExternalLink size={12} className="opacity-60 group-hover:opacity-100 transition-opacity" />
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-slate-400">{clusters.find((c:any) => c.id === a.clusterId)?.name || 'Unknown'}</td><td className="px-8 py-5"><div className="flex flex-col gap-1.5 items-start"><span className="text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-slate-500/10 text-slate-400">{a.strategy || 'helm'}</span>{a.vpnEnabled && (<span className="text-[9px] px-2.5 py-0.5 rounded-md font-bold uppercase tracking-wider bg-green-500/10 text-green-400 border border-green-500/20 flex items-center gap-1"><Shield size={10} /> VPN</span>)}</div></td><td className="px-8 py-5"><span title={a.healthReason || undefined} className={`text-[10px] px-3 py-1 rounded-full font-bold uppercase ${deployStatusClass(a.status)}`}>{a.status}</span></td>
                      <td className="px-8 py-5 text-right flex justify-end items-center gap-3">
                        <button onClick={() => openDashboard('app', a.id)} className="px-4 py-2 bg-blue-600/10 hover:bg-blue-600 border border-blue-500/30 text-blue-400 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"><Activity size={14} /> Manage</button>
                        <button onClick={() => setConfirmDestroy({ type: 'app', id: a.id, name: a.name, isAbort: a.status === 'deploying' })} className="px-4 py-2 bg-slate-700/50 hover:bg-red-600 border border-slate-600 hover:border-red-500 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"><Trash2 size={14} /> Destroy</button>
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
        {view === 'services' && <ServicesPanel />}
        {view === 'accounts' && (
          <CloudAccounts apiBase={API_BASE} />
        )}
        {view === 'mesh' && <MeshDevices apiBase={API_BASE} />}
        {view === 'lab' && <Lab apiBase={API_BASE} socketUrl={SOCKET_URL} />}
        {view === 'grove' && (
          <Grove apiBase={API_BASE} handoff={handoff} onHandoffTaken={() => setHandoff(undefined)} />
        )}
        {(view === 'chat' || view === 'board') && (
          <Workspace
            apiBase={API_BASE}
            handoff={handoff}
            onHandoffTaken={() => setHandoff(undefined)}
            onReview={(branchId, prompt) => setHandoff({ branchId, prompt })}
          />
        )}

        {view === 'personas' && <Personas apiBase={API_BASE} />}

        {view === 'trees' && (
          <TreesView
            apiBase={API_BASE}
            /**
             * The board hands a failure to Koala: switch to the conversation and carry the
             * evidence with it. Reviewing is a normal chat turn, so what arrives is an answer
             * being written rather than an empty box.
             */
            onReview={(branchId, prompt) => { setHandoff({ branchId, prompt }); setView('board'); }}
          />
        )}
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
          <Projects apiBase={API_BASE} socketUrl={SOCKET_URL} clusters={clusters} />
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
                  <div><strong>Created:</strong> {new Date(user.createdAt).toLocaleDateString()}</div>
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
                        onChange={(e) => update2FASettings(e.target.checked, user.twoFactorPhone, user.twoFactorPreferredMethod)}
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
                          onChange={(e) => update2FASettings(user.twoFactorEnabled, user.twoFactorPhone, e.target.value as any)}
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
                            onChange={(e) => update2FASettings(user.twoFactorEnabled, e.target.value, user.twoFactorPreferredMethod)}
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
                <button onClick={() => {setShowLogModal(null); setSelectedPod(null);}} className="text-slate-400 hover:text-white"><X size={24} /></button>
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
                    if (s === 3 && !isModelApp(wizardData.appType)) return null;
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
                  <div>
                    <label htmlFor="wizard-target-cluster" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Target Cluster</label>
                    <select id="wizard-target-cluster" value={wizardData.clusterId} onChange={e => setWizardData({...wizardData, clusterId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all">
                      <option value="">Select a healthy cluster...</option>
                      {clusters.filter((c: any) => c.status === 'healthy' && (!GPU_ONLY_APP_TYPES.has(wizardData.appType) || c.gpuEnabled)).map((c: any) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.provider}{c.gpuEnabled ? ' • GPU' : ''})</option>
                      ))}
                    </select>
                    {GPU_ONLY_APP_TYPES.has(wizardData.appType) && (
                      clusters.some((c: any) => c.status === 'healthy' && c.gpuEnabled) ? (
                        <p className="text-[11px] text-amber-400/80 mt-2">Only GPU-enabled clusters are shown — {wizardData.appType} needs GPU passthrough.</p>
                      ) : (
                        <p className="text-[11px] text-red-400/80 mt-2">No GPU-enabled clusters found — check the System cluster's status in the Clusters view.</p>
                      )
                    )}
                  </div>
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
                    wizardData.appType === 'tabbyapi' ? wizardData.tabbyModel : wizardData.odooRepo,
                    // Clears the old bpw revision on model switch — otherwise a stale branch
                    // name from the previous model lingers (it almost certainly doesn't exist
                    // on the new repo) and blocks the auto-select-highest-bpw effect below,
                    // which only fires when tabbyRevision is empty.
                    (id) => setWizardData(wizardData.appType === 'tabbyapi' ? {...wizardData, tabbyModel: id, tabbyRevision: ''} : {...wizardData, odooRepo: id}),
                    wizardData.appType === 'tabbyapi' ? 'e.g. qwen, llama, gemma... (filters the exl3 collection)' : undefined,
                  )}
                  {(wizardData.appType === 'tabbyapi' ? wizardData.tabbyModel : wizardData.odooRepo) && (
                    <div className="p-4 bg-blue-500/5 border border-blue-500/20 rounded-xl text-xs text-blue-300 flex items-center gap-2">
                      <Check size={14} /> Selected: <span className="font-mono">{wizardData.appType === 'tabbyapi' ? wizardData.tabbyModel : wizardData.odooRepo}</span>
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
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Model ID</label><input value={wizardData.odooRepo} onChange={e => setWizardData({...wizardData, odooRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" placeholder="e.g. meta-llama/Llama-3.2-3B-Instruct" /></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Count</label><select value={wizardData.odooTag === '0' ? '0' : wizardData.odooTag || '1'} onChange={e => setWizardData({...wizardData, odooTag: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm"><option value="1">1 GPU</option><option value="2">2 GPUs</option><option value="4">4 GPUs</option><option value="0">CPU Only (No GPU)</option></select>
                    {loadingVllmModelSize && (
                      <p className="text-[11px] text-slate-500 mt-2 flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> Checking model size on Hugging Face...</p>
                    )}
                    {!loadingVllmModelSize && vllmModelSize?.totalBytes && (
                      <div className="text-[11px] text-blue-400 mt-2 space-y-1">
                        <p>~{(vllmModelSize.totalBytes / 1e9).toFixed(1)} GB download ({vllmModelSize.fileCount} files)</p>
                        {vllmModelSize.weightBytesPerGpu !== undefined && vllmModelSize.kvCacheBytesPerGpu !== undefined && wizardData.odooTag !== '0' && (
                          <p className={vllmModelSize.weightBytesPerGpu + vllmModelSize.kvCacheBytesPerGpu > 20e9 ? 'text-amber-400/90' : ''}>
                            Est. VRAM per GPU at {parseInt(wizardData.vllmMaxModelLen || '0').toLocaleString() || 'default'} tokens: ~{((vllmModelSize.weightBytesPerGpu + vllmModelSize.kvCacheBytesPerGpu) / 1e9).toFixed(1)} GB
                            {' '}(weights ~{(vllmModelSize.weightBytesPerGpu / 1e9).toFixed(1)}GB + KV cache ~{(vllmModelSize.kvCacheBytesPerGpu / 1e9).toFixed(1)}GB, fp16 assumed) — rough estimate, check this fits your GPU's VRAM.
                          </p>
                        )}
                      </div>
                    )}
                    {!loadingVllmModelSize && vllmModelSizeError && (
                      <p className="text-[11px] text-amber-400/80 mt-2">Couldn't look up this model's size (check the model ID) — deployment will still work.</p>
                    )}
                  </div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Vendor</label><select value={wizardData.pgRepo || 'nvidia'} onChange={e => setWizardData({...wizardData, pgRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm"><option value="nvidia">NVIDIA CUDA</option><option value="amd">AMD ROCm</option></select></div>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Hugging Face Access Token (HF_TOKEN)</label>
                      {hasHfAccount && (
                        <span className="text-[10px] font-bold text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded flex items-center gap-1">
                          ✓ Account Token Saved
                        </span>
                      )}
                    </div>
                    <input type="password" value={wizardData.pgTag || ''} onChange={e => setWizardData({...wizardData, pgTag: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={hasHfAccount ? "Auto-using saved account token (or enter custom token)" : "e.g. hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"} />
                    <p className="text-[11px] text-slate-500 mt-1">
                      {hasHfAccount
                        ? "Saved token from Cloud Accounts will automatically be used if left blank. Enter a value above only to override."
                        : "Required for gated models (e.g. Llama 3.2, Gemma 2). Get a Read token at huggingface.co/settings/tokens or save it in Cloud Accounts."}
                    </p>
                  </div>
                  <div className="pt-2 border-t border-slate-800">
                    <button type="button" onClick={() => setShowVllmAdvanced(!showVllmAdvanced)} className="flex items-center gap-2 text-[11px] font-black text-slate-400 uppercase tracking-widest hover:text-slate-200 transition-colors">
                      {showVllmAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Advanced vLLM Arguments
                    </button>
                    {showVllmAdvanced && (
                      <div className="mt-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Model Length (--max-model-len)</label>
                          <input type="number" value={wizardData.vllmMaxModelLen} onChange={e => setWizardData({...wizardData, vllmMaxModelLen: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 32768 (leave blank for model default)" />
                          <p className="text-[11px] text-slate-500 mt-1">Lower this if you see a KV-cache-too-small error at startup.</p>
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Memory Utilization (--gpu-memory-utilization)</label>
                          <input type="number" step="0.05" min="0" max="1" value={wizardData.vllmGpuMemUtil} onChange={e => setWizardData({...wizardData, vllmGpuMemUtil: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 0.9 (leave blank for vLLM default)" />
                          <p className="text-[11px] text-slate-500 mt-1">Fraction of GPU VRAM vLLM is allowed to reserve for weights + KV cache.</p>
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Served Model Name</label>
                          <input value={wizardData.vllmServedModelName} onChange={e => setWizardData({...wizardData, vllmServedModelName: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="Alias exposed via the API — defaults to the model ID" />
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Concurrent Sequences (--max-num-seqs)</label>
                          <input type="number" value={wizardData.vllmMaxNumSeqs} onChange={e => setWizardData({...wizardData, vllmMaxNumSeqs: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 256 (leave blank for vLLM default)" />
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Data Type (--dtype)</label>
                          <select value={wizardData.vllmDtype} onChange={e => setWizardData({...wizardData, vllmDtype: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
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
                        <div className="pt-2 border-t border-slate-800/80 flex flex-col gap-3">
                          <div className="flex items-center gap-3">
                            <input type="checkbox" id="wiz-tool-calling" checked={wizardData.vllmToolCallingEnabled} onChange={e => setWizardData({...wizardData, vllmToolCallingEnabled: e.target.checked})} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                            <label htmlFor="wiz-tool-calling" className="text-sm text-slate-300 cursor-pointer select-none">Enable Tool Calling</label>
                            <span className="text-[10px] text-slate-500 ml-auto">Required for OpenAI-style function/tool calls</span>
                          </div>
                          {wizardData.vllmToolCallingEnabled && (
                            <div>
                              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Tool Call Parser</label>
                              <select value={wizardData.vllmToolCallParser} onChange={e => setWizardData({...wizardData, vllmToolCallParser: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
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
                              {!wizardData.vllmToolCallParser && (
                                <p className="text-[11px] text-amber-400/80 mt-2">vLLM requires a parser whenever tool calling is enabled — "auto" tool choice will fail to start without one.</p>
                              )}
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Additional Arguments</label>
                          <textarea value={wizardData.vllmExtraArgs} onChange={e => setWizardData({...wizardData, vllmExtraArgs: e.target.value})} rows={3} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="Any other vllm serve flags" />
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
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">HuggingFace Model ID</label><input value={wizardData.tabbyModel} onChange={e => setWizardData({...wizardData, tabbyModel: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" placeholder="e.g. bartowski/Llama-3.2-3B-Instruct-exl2" /></div>
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Revision / Branch (optional)</label>
                    <input value={wizardData.tabbyRevision} onChange={e => setWizardData({...wizardData, tabbyRevision: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 6.0bpw — EXL2/EXL3 quants are usually split across repo branches" />
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
                      <p className="text-[11px] text-amber-400/80 mt-2">Couldn't look up this model's size (check the model ID/revision) — deployment will still work, sizing falls back to an estimate.</p>
                    )}
                  </div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">GPU Count</label><select value={wizardData.tabbyGpuCount} onChange={e => setWizardData({...wizardData, tabbyGpuCount: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm"><option value="1">1 GPU</option><option value="2">2 GPUs</option><option value="4">4 GPUs</option></select>
                    <p className="text-[11px] text-slate-500 mt-1">TabbyAPI's exllamav3 backend is NVIDIA CUDA-only — there's no CPU or ROCm mode.</p>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Hugging Face Access Token (HF_TOKEN)</label>
                      {hasHfAccount && (
                        <span className="text-[10px] font-bold text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded flex items-center gap-1">
                          ✓ Account Token Saved
                        </span>
                      )}
                    </div>
                    <input type="password" value={wizardData.tabbyHfToken} onChange={e => setWizardData({...wizardData, tabbyHfToken: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={hasHfAccount ? "Auto-using saved account token (or enter custom token)" : "e.g. hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"} />
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
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cache Mode</label>
                          <select value={wizardData.tabbyCacheMode} onChange={e => setWizardData({...wizardData, tabbyCacheMode: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                            <option value="">FP16 (default)</option>
                            <option value="Q8">Q8 — saves VRAM, minor quality loss</option>
                            <option value="Q6">Q6</option>
                            <option value="Q4">Q4 — most VRAM savings</option>
                          </select>
                          <p className="text-[11px] text-slate-500 mt-1">Quantizes the KV cache. Lower it if you're VRAM-constrained.</p>
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Sequence Length</label>
                          <input type="number" value={wizardData.tabbyMaxSeqLen} onChange={e => setWizardData({...wizardData, tabbyMaxSeqLen: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 32768 (leave blank for model default)" />
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Max Concurrent Generations</label>
                          <input type="number" value={wizardData.tabbyMaxBatchSize} onChange={e => setWizardData({...wizardData, tabbyMaxBatchSize: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder="e.g. 8 (leave blank for TabbyAPI default)" />
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Image Variant</label>
                          <select value={wizardData.tabbyImageTag} onChange={e => setWizardData({...wizardData, tabbyImageTag: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                            {tabbyImageTagOptions.length === 0 && <option value={wizardData.tabbyImageTag}>{loadingTabbyImageTags ? 'Checking available images...' : wizardData.tabbyImageTag}</option>}
                            {tabbyImageTagOptions.map(opt => (
                              <option key={opt.tag} value={opt.tag}>{opt.label}{opt.cached ? ' ✓ cached locally' : ''}</option>
                            ))}
                          </select>
                          {loadingTabbyImageTags && <p className="text-[11px] text-slate-500 mt-1">Fetching available tags from ghcr.io...</p>}
                        </div>
                        <div className="flex items-center gap-3">
                          <input type="checkbox" id="wiz-tabby-reasoning" checked={wizardData.tabbyReasoning} onChange={e => setWizardData({...wizardData, tabbyReasoning: e.target.checked})} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
                          <label htmlFor="wiz-tabby-reasoning" className="text-sm text-slate-300 cursor-pointer select-none">Reasoning Model</label>
                          <span className="text-[10px] text-slate-500 ml-auto">Enable for thinking models (e.g. DeepSeek-R1 style)</span>
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Tool Call Format</label>
                          <select value={wizardData.tabbyToolFormat} onChange={e => setWizardData({...wizardData, tabbyToolFormat: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                            <option value="">None — tool calls won't be parsed</option>
                            {TABBY_TOOL_FORMATS.map(fmt => <option key={fmt} value={fmt}>{fmt}</option>)}
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
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Memory Limit (RAM)</label>
                            <input value={wizardData.tabbyMemoryLimit} onChange={e => setWizardData({...wizardData, tabbyMemoryLimit: e.target.value})} placeholder="32G (default)" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm" />
                          </div>
                          <div>
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Shared Memory (/dev/shm)</label>
                            <input value={wizardData.tabbyShmSize} onChange={e => setWizardData({...wizardData, tabbyShmSize: e.target.value})} placeholder="16Gi (default)" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm" />
                          </div>
                          <div>
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">CPU Limit</label>
                            <input value={wizardData.tabbyCpuLimit} onChange={e => setWizardData({...wizardData, tabbyCpuLimit: e.target.value})} placeholder="10 (default)" className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm" />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Additional Config (env overrides)</label>
                          <textarea value={wizardData.tabbyExtraEnv} onChange={e => setWizardData({...wizardData, tabbyExtraEnv: e.target.value})} rows={3} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={"One per line, e.g.\nTABBY_MODEL_CHUNK_SIZE=4096\nTABBY_MODEL_ROPE_SCALE=1.0"} />
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
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Docker Repository</label><input value={wizardData.odooRepo} onChange={e => setWizardData({...wizardData, odooRepo: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm" /></div>
                  <div><label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Available Tags</label>{loadingOdooTags ? (<div className="flex items-center gap-2 text-slate-500 py-3"><Loader2 size={16} className="animate-spin" /> Fetching tags...</div>) : (<div className="grid grid-cols-2 gap-2">{odooTags.map((tag: string) => (<button key={tag} onClick={() => setWizardData({...wizardData, odooTag: tag})} className={`px-4 py-2 rounded-lg text-left text-xs border transition-all ${wizardData.odooTag === tag ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>{tag}</button>))}</div>)}</div>
                  {wizardData.appType === 'openwebui' && (
                    <div>
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">LLM Backend (vLLM / TabbyAPI Deployment)</label>
                      <select value={wizardData.openWebuiTargetId} onChange={e => setWizardData({...wizardData, openWebuiTargetId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                        <option value="">No backend (configure manually later)</option>
                        {deployments.filter((d: any) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).map((d: any) => (
                          <option key={d.id} value={d.id}>{d.name} ({d.vllmModel || d.tabbyModel || (d.appType === 'tabbyapi' ? 'TabbyAPI' : 'vLLM')})</option>
                        ))}
                      </select>
                      {deployments.filter((d: any) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).length === 0 ? (
                        deployments.some((d: any) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running') ? (
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
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">LLM Backend (vLLM / TabbyAPI Deployment)</label>
                      <select value={wizardData.hermesTargetId} onChange={e => setWizardData({...wizardData, hermesTargetId: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                        <option value="">No backend (configure manually later)</option>
                        {deployments.filter((d: any) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).map((d: any) => (
                          <option key={d.id} value={d.id}>{d.name} ({d.vllmModel || d.tabbyModel || (d.appType === 'tabbyapi' ? 'TabbyAPI' : 'vLLM')})</option>
                        ))}
                      </select>
                      {deployments.filter((d: any) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running' && d.clusterId === wizardData.clusterId).length === 0 ? (
                        deployments.some((d: any) => (d.appType === 'vllm' || d.appType === 'tabbyapi') && d.status === 'running') ? (
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
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Search Engine</label>
                            <select value={wizardData.webuiWebSearchEngine} onChange={e => setWizardData({...wizardData, webuiWebSearchEngine: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
                              <option value="duckduckgo">DuckDuckGo — no API key needed</option>
                              <option value="tavily">Tavily</option>
                              <option value="brave">Brave Search</option>
                              <option value="serper">Serper</option>
                              <option value="bing">Bing</option>
                            </select>
                          </div>
                          {wizardData.webuiWebSearchEngine !== 'duckduckgo' && (
                            <div>
                              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">API Key</label>
                              <input type="password" value={wizardData.webuiWebSearchApiKey} onChange={e => setWizardData({...wizardData, webuiWebSearchApiKey: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm font-mono" placeholder={`API key for ${wizardData.webuiWebSearchEngine}`} />
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
                    <div className="flex justify-between border-b border-slate-800 pb-3"><span>{wizardData.appType.charAt(0).toUpperCase() + wizardData.appType.slice(1)}</span><span className="font-mono text-xs text-slate-300">{wizardData.appType === 'tabbyapi' ? `${wizardData.tabbyModel}${wizardData.tabbyRevision ? '@' + wizardData.tabbyRevision : ''} (${wizardData.tabbyGpuCount} GPU)` : `${wizardData.odooRepo}:${wizardData.odooTag}`}</span></div>
                    {APP_DEFAULTS[wizardData.appType].hasDatabase && (
                      <div className="flex justify-between"><span>Database</span><span className="font-mono text-xs text-slate-300">{wizardData.pgRepo}:{wizardData.pgTag}</span></div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-10 flex gap-4 pt-8 border-t border-slate-700">{wizardStep > 1 && (<button onClick={prevStep} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2"><ArrowLeft size={18} /> Back</button>)}<div className="flex-1"></div>{wizardStep < 6 ? (<button disabled={(wizardStep === 1 && !wizardData.clusterId)} onClick={nextStep} className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 disabled:opacity-50">Next <ArrowRight size={18} /></button>) : (<button onClick={() => { const payload = wizardData.appType === 'vllm' ? { ...wizardData, vllmModel: wizardData.odooRepo, vllmGpuCount: parseInt(wizardData.odooTag) || 1, vllmGpuVendor: wizardData.pgRepo || 'nvidia', vllmHfToken: wizardData.pgTag || '', vllmMaxModelLen: wizardData.vllmMaxModelLen ? parseInt(wizardData.vllmMaxModelLen) : undefined, vllmGpuMemUtil: wizardData.vllmGpuMemUtil ? parseFloat(wizardData.vllmGpuMemUtil) : undefined, vllmExtraArgs: wizardData.vllmExtraArgs || undefined, vllmToolCallingEnabled: wizardData.vllmToolCallingEnabled && !!wizardData.vllmToolCallParser, vllmToolCallParser: wizardData.vllmToolCallParser || undefined, vllmServedModelName: wizardData.vllmServedModelName || undefined, vllmMaxNumSeqs: wizardData.vllmMaxNumSeqs ? parseInt(wizardData.vllmMaxNumSeqs) : undefined, vllmDtype: wizardData.vllmDtype || undefined, appType: 'vllm', strategy: 'native' } : wizardData.appType === 'tabbyapi' ? { ...wizardData, tabbyGpuCount: parseInt(wizardData.tabbyGpuCount) || 1, tabbyRevision: wizardData.tabbyRevision || undefined, tabbyHfToken: wizardData.tabbyHfToken || undefined, tabbyCacheMode: wizardData.tabbyCacheMode || undefined, tabbyMaxSeqLen: wizardData.tabbyMaxSeqLen ? parseInt(wizardData.tabbyMaxSeqLen) : undefined, tabbyMaxBatchSize: wizardData.tabbyMaxBatchSize ? parseInt(wizardData.tabbyMaxBatchSize) : undefined, tabbyToolFormat: wizardData.tabbyToolFormat || undefined, appType: 'tabbyapi', strategy: 'native' } : wizardData.appType === 'openwebui' ? { ...wizardData, openWebuiTargetId: wizardData.openWebuiTargetId || undefined, webuiWebSearchApiKey: wizardData.webuiWebSearchApiKey || undefined, appType: 'openwebui', strategy: 'native' } : wizardData.appType === 'hermes' ? { ...wizardData, hermesTargetId: wizardData.hermesTargetId || undefined, appType: 'hermes', strategy: 'native' } : wizardData.appType === 'palworld' ? { ...wizardData, appSettings: { SERVER_NAME: wizardData.name || 'A Palworld Server', PLAYERS: String(parseInt(wizardData.palworldPlayers) || 16) }, appType: 'palworld', strategy: 'native' } : wizardData; deployApp.mutate(payload); }} className="px-10 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold">🚀 Initiate Deployment</button>)}</div>
          </div>
        </div>
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
