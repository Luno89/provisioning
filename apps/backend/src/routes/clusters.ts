import { Router, type Request } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { asyncRoute } from '../middleware/async-route.js';
import { validateClusterName } from '../lib/cluster-name.js';
import { decryptValue } from '../lib/crypto.js';
import { generateSshKeypair } from '../lib/ssh-keypair.js';
import type { Database } from '../lib/db-interface.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { AppService } from '../services/AppService.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { GiteaService } from '../services/GiteaService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';

/**
 * Clusters: create, destroy, inspect, and proxy into their dashboards.
 *
 * ── WHAT MOVING THIS REVEALED ──
 * The cluster-proxy routes lived between the GitHub and Google OAuth callbacks in index.ts — 300
 * lines from the other cluster routes, in the middle of the auth section. Nothing was wrong with
 * them; there was simply nowhere for them to go, so they were registered wherever the person adding
 * them happened to be. That is what 150 routes on one `app` object does, and it is the argument for
 * routers more than any amount of file length is.
 *
 * ── DEPENDENCIES ──
 * Seven, which is more than the credentials router needed and is the honest count: these routes
 * create infrastructure through Temporal, read it through the Kubernetes API, tunnel into it, and
 * clean up after it. Naming them in one options object is the point — previously they reached for
 * whatever `bootstrap()` had in scope, and there was no way to see what a route actually touched
 * short of reading it.
 */
export interface ClustersRouterDeps {
  clusterService: ClusterService;
  appService: Pick<AppService, 'discoverDeployments'>;
  clusterProxyService: Pick<ClusterProxyService, 'ensurePortForward' | 'stopForCluster' | 'getAutoLoginCookies'>;
  /** Used by the Gitea dashboard proxy to mint a session on the browser's behalf. */
  giteaService: GiteaService;
  infraService: Pick<InfrastructureService, 'runKubectl'>;
  temporalBridge: TemporalBridge;
  db: Pick<Database, 'getClusters' | 'saveClusterList'>;
  /** Passed to `getAll`, which emits progress while it reconciles. */
  io: SocketServer;
  /** Decrypts a stored SSH key on the destroy path. */
  jwtSecret: string;
}

/**
 * The `:id` from the path, narrowed once.
 *
 * Express types `req.params` loosely enough that a handler wrapped in `asyncRoute` sees
 * `string | string[] | undefined`. Asserting it in each of the fourteen places it is read would be
 * fourteen chances to assert it differently.
 */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. Narrowed to what these handlers read. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function clustersRouter(deps: ClustersRouterDeps): Router {
  const {
    clusterService, appService, clusterProxyService, infraService,
    temporalBridge, db, io, giteaService,
  } = deps;
  const JWT_SECRET = deps.jwtSecret;
  const router = Router();

  const PROXY_SERVICES = ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager'] as const;

  // Chart-generated admin password (constructs/monitoring.ts's kube-prometheus-stack release) —
  // only ever used server-side to log in on the browser's behalf (see the auto-login block
  // below), never returned to a client.
  async function getGrafanaAdminCredentials(kubeconfigPath: string): Promise<{ username: string; password: string }> {
    const raw = await infraService.runKubectl(
      ['get', 'secret', 'kube-prometheus-stack-grafana', '-n', 'monitoring', '-o', 'jsonpath={.data.admin-password}'],
      kubeconfigPath,
    );
    return { username: 'admin', password: Buffer.from(raw.trim(), 'base64').toString('utf8') };
  }

  for (const serviceKey of PROXY_SERVICES) {
    router.get(`/:id/proxy/${serviceKey}`, async (req, res) => {
      try {
        const clusterId = idOf(req);
        const cluster = await clusterService.getById(clusterId, userOf(req).id);
        if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

        const kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
        const targetUrl = await clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath);

        // Gitea sends X-Frame-Options: SAMEORIGIN unconditionally — confirmed live that even
        // explicitly clearing gitea.config.security.X_FRAME_OPTIONS via Helm doesn't change the
        // emitted header (an empty value isn't treated as "disable", it falls back to the
        // compiled-in default). Grafana defaults to X-Frame-Options: deny (its own
        // allow_embedding setting off by default) — stricter still, blocks framing from any
        // origin including its own. Both would just render blank in a real browser's iframe.
        // A redirect sidesteps it for both — also arguably better UX for full standalone apps
        // like these vs. a genuinely embeddable dashboard like Prometheus/Traefik.
        if (serviceKey === 'gitea' || serviceKey === 'grafana') {
          // Auto-login: relay a real session cookie from the service's own login flow (see
          // ClusterProxyService.getAutoLoginCookies) so the user lands already signed in — the
          // password is fetched/used server-side only and never reaches the browser. Best-effort:
          // if this ever fails (chart password rotated, service briefly unreachable, etc.), fall
          // straight through to a plain redirect — the user just sees the normal login screen
          // instead of a broken proxy link.
          try {
            const credentials = serviceKey === 'gitea'
              ? await giteaService.getAdminCredentials()
              : await getGrafanaAdminCredentials(kubeconfigPath);
            const cookies = await clusterProxyService.getAutoLoginCookies(serviceKey, targetUrl, credentials);
            for (const cookie of cookies) res.append('Set-Cookie', cookie);
          } catch (err: any) {
            console.warn(`[proxy] Auto-login failed for ${serviceKey}: ${err.message} — falling back to manual login`);
          }
          return res.redirect(302, targetUrl);
        }

        res.setHeader('Content-Type', 'text/html');
        res.send(`<!DOCTYPE html><html><head><title>${serviceKey}</title></head><body style="margin:0"><iframe src="${targetUrl}" style="width:100%;height:100vh;border:none"></iframe></body></html>`);
      } catch (err: any) {
        res.status(502).json({ error: `Service unavailable: ${err.message}` });
      }
    });
  }

  /**
   * ── asyncRoute ON THE HANDLERS THAT HAVE NO CATCH ──
   *
   * Express 4 does not await a handler, so a rejected promise produces an unhandled rejection and
   * NO response — the client hangs until it times out. The multi-line handlers below each carry
   * their own try/catch, several with a status that means something (502 for a service that cannot
   * be reached, 503 for Temporal being down), and those are left exactly as they were.
   *
   * These four one-liners had nothing. `clusterService.listAllPods` reaching an unreachable cluster
   * is not hypothetical, and it hung the request rather than reporting it.
   */
  router.get('/', asyncRoute(async (req, res) => res.json(await clusterService.getAll(userOf(req).id, io))));

  router.post('/', async (req, res) => {
    try {
      // Checked here, synchronously, rather than inside the workflow: the name becomes a
      // TerraformStack id and a Kubernetes object name, so an invalid one fails deep inside a
      // CDKTF subprocess minutes later with "Cannot create TerraformStack with id ... It contains
      // a whitespace character" — after a VM may already have been created and billed.
      const nameCheck = validateClusterName(req.body.name);
      if (!nameCheck.ok) {
        return res.status(400).json({
          error: nameCheck.error,
          ...(nameCheck.suggestion ? { suggestion: nameCheck.suggestion } : {}),
        });
      }

      const remote = req.body.provider === 'remote'
        ? {
            host: req.body.remoteHost,
            username: req.body.remoteUsername,
            privateKey: req.body.remoteSshPrivateKey,
            ...(typeof req.body.remoteSshPort === 'number' ? { port: req.body.remoteSshPort } : {}),
            ...(typeof req.body.remoteK3sApiPort === 'number' ? { k3sApiPort: req.body.remoteK3sApiPort } : {}),
          }
        : undefined;
      if (remote && (!remote.host || !remote.username)) {
        return res.status(400).json({ error: 'remoteHost and remoteUsername are required for provider "remote"' });
      }

      // No private key supplied → generate the pair here and hand back only the PUBLIC half.
      //
      // The alternative, which this replaces, was asking the user to paste their own private key
      // into a textarea. That is the wrong direction for a hosted product: an invited user should
      // never surrender a credential to it, and a key that arrives this way is one we cannot
      // bound the scope of — it may well be their everyday key with access to everything else
      // they own. Generating here means the private half never leaves the server and the user
      // authorises exactly one key, for exactly this.
      //
      // The cluster is saved in 'awaiting-key' rather than provisioning immediately, because the
      // key is useless until they have actually installed it. Starting the workflow now would
      // burn all three attempts on Permission denied before they had a chance.
      if (remote && !remote.privateKey) {
        const pair = await generateSshKeypair(`nowrinkles-${req.body.name}`);
        const saved = await clusterService.createAwaitingKey({
          name: req.body.name,
          ownerId: userOf(req).id,
          host: remote.host,
          username: remote.username,
          privateKey: pair.privateKey,
          ...(remote.port !== undefined ? { port: remote.port } : {}),
        });
        return res.status(201).json({
          id: saved.id,
          status: 'awaiting-key',
          publicKey: pair.publicKey.trim(),
          message: 'Authorise this key on the machine, then start provisioning.',
        });
      }
      const hetzner = req.body.provider === 'hetzner'
        ? {
            ...(req.body.hetznerServerType ? { serverType: String(req.body.hetznerServerType) } : {}),
            ...(req.body.hetznerLocation ? { location: String(req.body.hetznerLocation) } : {}),
            ...(req.body.hetznerImage ? { image: String(req.body.hetznerImage) } : {}),
          }
        : undefined;
      const info = await temporalBridge.provision(req.body.name, req.body.provider, userOf(req).id, remote, hetzner);
      res.status(202).json({
        message: 'Provisioning started',
        clusterName: req.body.name,
        provider: req.body.provider,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal cluster provisioning unavailable: ${err.message}` });
    }
  });

  // No standalone POST .../abort route: DELETE below already checks cluster.status ===
  // 'provisioning' and calls clusterService.abort() itself — a second route hitting the exact
  // same service method just meant two API paths (and two frontend buttons) for one operation.

  /**
   * Begins provisioning a cluster that was parked in 'awaiting-key' — the user has now installed
   * the public key we generated, so the private half we already hold will actually authenticate.
   *
   * Separate from POST /api/clusters because the key is useless until it is installed: starting
   * the workflow at creation time would spend all three of ProvisionClusterActivity's attempts on
   * "Permission denied (publickey)" before the user had a chance to paste anything.
   */
  router.post('/:id/start', async (req, res) => {
    try {
      const userId = userOf(req).id;
      // Ownership-scoped: getById filters by owner, so another tenant's id is simply not found.
      const cluster = await clusterService.getById(idOf(req), userId);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
      if (cluster.status !== 'awaiting-key') {
        return res.status(409).json({ error: `Cluster "${cluster.name}" is ${cluster.status}, not awaiting a key.` });
      }
      if (!cluster.remoteHost || !cluster.remoteUsername || !cluster.remoteSshPrivateKeyEnc) {
        return res.status(400).json({ error: 'Cluster is missing its connection details.' });
      }

      const info = await temporalBridge.provision(cluster.name, 'remote', userId, {
        host: cluster.remoteHost,
        username: cluster.remoteUsername,
        privateKey: decryptValue(cluster.remoteSshPrivateKeyEnc, JWT_SECRET),
        ...(cluster.remoteSshPort !== undefined ? { port: cluster.remoteSshPort } : {}),
      });

      // provision() writes its own cluster row; drop the placeholder so the UI doesn't show two.
      const all = await db.getClusters();
      await db.saveClusterList(all.filter((c) => c.id !== cluster.id));

      res.status(202).json({ message: 'Provisioning started', id: info.resourceId, workflowId: info.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    if (idOf(req) === 'provisioning-lunorica') {
      return res.status(403).json({ error: 'The system management cluster cannot be destroyed' });
    }
    try {
      const cluster = await clusterService.getById(idOf(req), userOf(req).id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
      clusterProxyService.stopForCluster(idOf(req));
      if (cluster.status === 'provisioning') {
        await clusterService.abort(idOf(req), userOf(req).id, io);
        return res.json({ success: true, message: 'Cluster provisioning aborted' });
      }
      const info = await temporalBridge.destroyCluster(idOf(req));
      res.status(202).json({
        message: 'Destroying cluster',
        clusterId: idOf(req),
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      // Fallback to clusterService.delete or abort
      try {
        await clusterService.abort(idOf(req), userOf(req).id, io);
        res.json({ success: true, message: 'Cluster deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Cluster destruction unavailable: ${err.message}` });
      }
    }
  });

  router.post('/discover', async (req, res) => {
    try {
      const discovered = await clusterService.discoverClusters(userOf(req).id);
      res.json({ clusters: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/discover-deployments', async (req, res) => {
    try {
      const discovered = await appService.discoverDeployments(idOf(req), userOf(req).id);
      res.json({ deployments: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id/all-pods', asyncRoute(async (req, res) => res.json(await clusterService.listAllPods(idOf(req), userOf(req).id))));
  router.get('/:id/helm-releases', asyncRoute(async (req, res) => res.json(await clusterService.listReleases(idOf(req), userOf(req).id))));
  router.get('/:id/gpu-status', asyncRoute(async (req, res) => res.json(await clusterService.getGpuStatus(idOf(req), userOf(req).id))));

  router.get('/:id/services', async (req, res) => {
    try {
      const cluster = await clusterService.getById(idOf(req), userOf(req).id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const releases = await clusterService.listReleases(idOf(req), userOf(req).id);
      const pods = await clusterService.listAllPods(idOf(req), userOf(req).id);

      // Grafana ships as a subchart *inside* the kube-prometheus-stack release (see
      // constructs/monitoring.ts: grafana.enabled=true), not its own separate Helm release —
      // matching only 'kube-prometheus-stack-grafana' here would never find a release and
      // always show "Not Installed" even when Grafana is actually running. Separate from
      // POD_NAME_PATTERNS below: this is only for the installed/status/chart/version fields,
      // not which pods list under each leaf — sharing one list for both would make Prometheus
      // and Grafana's leaves show each other's pods too. Confirmed live.
      const RELEASE_NAMES: Record<string, string[]> = {
        prometheus: ['kube-prometheus-stack', 'prometheus-server', 'prometheus'],
        grafana: ['kube-prometheus-stack', 'kube-prometheus-stack-grafana', 'grafana'],
        traefik: ['traefik'],
        gitea: ['gitea'],
        // Alertmanager ships as a subchart of kube-prometheus-stack too (same as Grafana above),
        // not its own release.
        alertmanager: ['kube-prometheus-stack'],
        // Loki and Promtail (constructs/logging.ts) are two separate Helm releases installed
        // together — matching either is enough for a simple installed/not-installed indicator on
        // one combined leaf (imperfect if exactly one of the two is down, acceptable for a
        // status leaf, not a health check).
        loki: ['loki', 'promtail'],
      };
      const POD_NAME_PATTERNS: Record<string, string[]> = {
        // Not 'alertmanager-kube-prometheus-stack' anymore — that now belongs solely to the
        // dedicated 'alertmanager' leaf below (same reasoning as Grafana already having its own
        // separate list: sharing pod patterns between two leaves makes them show each other's
        // pods too). Confirmed live.
        prometheus: ['kube-prometheus-stack-prometheus', 'kube-prometheus-stack-operator', 'kube-prometheus-stack-kube-state-metrics', 'kube-prometheus-stack-prometheus-node-exporter'],
        grafana: ['kube-prometheus-stack-grafana'],
        traefik: ['traefik'],
        gitea: ['gitea'],
        alertmanager: ['alertmanager-kube-prometheus-stack-alertmanager'],
        loki: ['loki', 'promtail'],
      };
      // Traefik deploys into its own 'traefik' namespace (constructs/ingress.ts), not
      // 'kube-system' — k3s's own bundled Traefik (which *would* live in kube-system) is
      // explicitly disabled at cluster-create time (scripts/cluster.sh: --disable=traefik),
      // so kube-system was never the right namespace for this platform's own Traefik release.
      // Confirmed live.
      const SERVICE_NAMESPACES: Record<string, string> = {
        prometheus: 'monitoring',
        grafana: 'monitoring',
        traefik: 'traefik',
        gitea: 'gitea',
        alertmanager: 'monitoring',
        loki: 'monitoring',
      };

      const services = Object.entries(RELEASE_NAMES).map(([serviceKey, chartNames]) => {
        const release = releases.find((r: any) => chartNames.includes(r.name));
        const namespace = SERVICE_NAMESPACES[serviceKey];
        const podPatterns = POD_NAME_PATTERNS[serviceKey] || [];
        const servicePods = Array.isArray(pods) ? pods.filter((p: any) =>
          p?.metadata?.namespace === namespace &&
          podPatterns.some(name => (p?.metadata?.name || '').includes(name))
        ) : [];

        return {
          name: serviceKey,
          installed: !!release,
          status: release?.status || 'not-installed',
          chart: release?.chart || null,
          appVersion: release?.app_version || null,
          namespace,
          pods: servicePods.map((p: any) => ({
            name: p?.metadata?.name || 'unknown',
            status: p?.status?.phase || 'Unknown',
            ip: p?.status?.podIP || null,
            ready: p?.status?.containerStatuses?.some((s: any) => s.ready) || false,
          })),
        };
      });

      res.json({ services });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  return router;
}
