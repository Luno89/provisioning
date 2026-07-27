import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { Server as SocketServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

// Library Imports
import { createDatabase } from './lib/db-interface.js';
import { migrateLegacyOwnership } from './lib/migrate-ownership.js';

// Service Imports
import { InfrastructureService } from './services/InfrastructureService.js';
import { ClusterService } from './services/ClusterService.js';
import { AppService } from './services/AppService.js';
import { RegistryService } from './services/RegistryService.js';
import { GitModuleService } from './services/GitModuleService.js';
import { BuilderService } from './services/BuilderService.js';
import { AppExposureService } from './services/AppExposureService.js';
import type { ClusterMetadata, DeploymentMetadata, InviteMetadata } from './lib/types.js';
import { validateAppSettings } from './lib/app-settings-schema.js';
import { APP_SETTINGS_SCHEMAS, NO_WEB_UI_APP_TYPES } from './lib/app-schemas.js';
import { VpsCatalogService } from './services/VpsCatalogService.js';
import { TemporalBridge } from './services/TemporalBridge.js';
import WorkerService from './services/WorkerService.js';
import { ClusterProxyService } from './services/ClusterProxyService.js';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import axios from 'axios';
import { signJWT, verifyJWT, hashPassword, verifyPassword } from './lib/auth.js';
import { AuthService } from './services/AuthService.js';
import { CredentialService } from './services/CredentialService.js';
import { GiteaService } from './services/GiteaService.js';
import { HeadscaleService } from './services/HeadscaleService.js';
import type { CloudProvider } from './lib/types.js';
import { getHfModelSize, getHfModelConfig, estimateKvCacheBytes, searchHfModels, getExl3ModelCollection, getHfModelBranches } from './lib/huggingface.js';
import { decryptValue, encryptValue } from './lib/crypto.js';

dotenv.config();

function startHostTunnel(port = 8000) {
  const server = net.createServer((socket) => {
    const child = spawn('docker', ['exec', '-i', 'provisioner-nginx', 'nc', '127.0.0.1', '80']);

    socket.pipe(child.stdin);
    child.stdout.pipe(socket);

    socket.on('error', () => child.kill());
    child.on('error', () => socket.destroy());
    socket.on('close', () => child.kill());
    child.on('close', () => socket.destroy());
  });

  server.on('error', (err: any) => {
    console.error(`Host tunnel server error: ${err.message}`);
  });

  server.listen(port, '::', () => {
    console.log(`🚀 Host Tunnel Server active on http://[::]:${port}`);
  });
}

const DEFAULT_LOG_LEVEL = 50;

/**
 * APPLICATION BOOTSTRAP
 *
 * The side-channel `TemporalBridge` is used by mutating API routes to route
 * through the long-lived Temporal workflow persistence engine.  All other
 * reads stay on the Local DB so they don't block until the workflow ends.
 */
export async function bootstrap(): Promise<{ app: express.Application; io: SocketServer; temporalBridge?: TemporalBridge }> {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: '*' } });
  const port = process.env.PORT || 3001;

  // ── 1. Initialize backend ────────────────────────────────────────────────
  const db = createDatabase();
  await db.init();
  await migrateLegacyOwnership(db);

  const infraService = new InfrastructureService();
  const builderService = new BuilderService(db, infraService);
  const clusterService = new ClusterService(db, infraService);
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);
  const appExposureService = new AppExposureService(db, infraService, clusterService, io);
  const clusterProxyService = new ClusterProxyService();
  const JWT_SECRET = process.env.JWT_SECRET || 'provisioning-platform-secret-12345';
  const giteaService = new GiteaService(infraService, JWT_SECRET, '/tmp/kubeconfig-provisioning-lunorica');
  const headscaleService = new HeadscaleService(JWT_SECRET, process.env.HEADSCALE_URL || 'http://localhost:8080');

  // Best-effort background check — see ClusterService.ensureSystemClusterGpuReady for why this
  // can't just be a side effect of the normal provisioning flow. Never blocks startup.
  clusterService.ensureSystemClusterGpuReady().catch((err: any) =>
    console.warn(`[bootstrap] System cluster GPU readiness check failed: ${err.message}`)
  );

  // ── 2. Temporal bridge (HTTP only → sketch → poll DB) ────────────────────
  const temporalBridge = new TemporalBridge(db, io, JWT_SECRET, clusterService);
  clusterService.setTemporalBridge(temporalBridge);
  appService.setTemporalBridge(temporalBridge);
  try {
    await temporalBridge.start();
    await temporalBridge.startActiveWorkflowRecovery();
  } catch (e: any) {
    // If Temporal is not reachable, serve the same UI with normal polling
    console.warn(`⚠️ Temporal TS bridge not available. Routes will fall back to Local DB.`, e.message);
  }

  const authService = new AuthService(db);
  app.use(cors({
    origin: (origin, callback) => {
      callback(null, true);
    },
    credentials: true,
  }));

  // Registered before the global express.json() (and outside the /api prefix, so it never
  // passes through requireAuth below) — needs the *raw* request body to verify Gitea's
  // HMAC-SHA256 signature; the global json() parser would consume it first otherwise. Gitea
  // calls this unauthenticated, so signature verification is the only gate.
  app.post('/webhooks/gitea/:projectId', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const projects = await db.getProjects();
      const project = projects.find((p: any) => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Unknown project' });
      if (!project.webhookSecretEnc) return res.status(500).json({ error: 'Project has no webhook secret configured' });

      const secret = decryptValue(project.webhookSecretEnc, JWT_SECRET);
      const rawBody = req.body as Buffer;
      if (!giteaService.verifyWebhookSignature(rawBody, req.header('X-Gitea-Signature'), secret)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      if (!payload.ref || !payload.after) return res.status(200).json({ status: 'ignored', reason: 'not a push event' });

      const ref = String(payload.ref).replace('refs/heads/', '');
      res.status(202).json({ status: 'accepted' });
      // Builds run in the background — Gitea has its own webhook-delivery timeout, don't block it.
      temporalBridge.runPipeline(project, payload.after, ref).catch((err: any) =>
        console.error(`[webhook] Failed to start pipeline run for project ${project.id}: ${err.message}`)
      );
    } catch (err: any) {
      console.error(`[webhook] Gitea webhook error: ${err.message}`);
      res.status(500).json({ error: 'Internal error processing webhook' });
    }
  });

  app.use(express.json());
  const credentialService = new CredentialService(db, JWT_SECRET);
  const vpsCatalogService = new VpsCatalogService(db, JWT_SECRET);

  function getCookie(req: express.Request, name: string): string | undefined {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return undefined;
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      const [k, v] = cookie.split('=');
      if (k === name) return v;
    }
    return undefined;
  }

  const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const publicPaths = [
      '/auth/login',
      '/auth/register',
      '/auth/2fa/verify',
      '/auth/github',
      '/auth/google',
      '/auth/github/callback',
      '/auth/google/callback',
    ];
    if (publicPaths.includes(req.path)) {
      return next();
    }
    if (process.env.IS_E2E === 'true') {
      const users = await db.getUsers();
      const mockUser = users[0] || {
        id: 'test-user-id',
        email: 'test@example.com',
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      (req as any).user = mockUser;
      return next();
    }

    const token = getCookie(req, 'session');
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Session missing' });
    }
    const decoded = verifyJWT(token, JWT_SECRET);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
    }
    const user = await db.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: User not found' });
    }
    (req as any).user = user;
    next();
  };

  app.use('/api', requireAuth);

  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(req as any).user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  // This system can spend real money via cloud APIs, so account creation is invite-gated —
  // except the very first user ever, who bootstraps the instance and becomes admin (mirrors
  // migrateLegacyOwnership's backfill logic for pre-existing installs). Consumes the invite
  // (stamps usedBy/usedAt) only on success, so a rejected registration doesn't burn the code.
  async function checkAndConsumeInvite(code: string | undefined, newUserId: string, isFirstUser: boolean): Promise<string | null> {
    if (isFirstUser) return null;
    if (!code) return 'An invite code is required to create an account';
    const invites = await db.getInvites();
    const invite = invites.find((i) => i.code === code);
    if (!invite) return 'Invalid invite code';
    if (invite.usedBy) return 'This invite code has already been used';
    await db.saveInvite({ ...invite, usedBy: newUserId, usedAt: new Date().toISOString() });
    return null;
  }

  // ── 3. SOCKET.IO ORCHESTRATION ───────────────────────────────────────────
  io.on('connection', (socket) => {
    const socketTails = new Map<string, any>();

    socket.on('join-room', async (id) => {
      socket.join(id);

      const existing = socketTails.get(id);
      if (existing) {
        existing.kill();
        socketTails.delete(id);
      }

      // Socket.IO has no auth handshake/middleware at all in this codebase (no `io.use(...)`,
      // unlike every `/api/*` route's requireAuth) — a real, pre-existing gap, not something
      // introduced here. There's no authenticated user id available to check ownership against,
      // so this reads straight from the DB (bypassing clusterService.getById's ownership check)
      // rather than pretend to enforce isolation against an identity that doesn't exist yet.
      // TODO(distributed-system plan, Phase 0 follow-up): give Socket.IO connections real auth.
      let resource: any = (await db.getClusters()).find((c: any) => c.id === id) ||
                       (await db.getDeployments()).find((d: any) => d.id === id);
      if (!resource) {
        const run = (await db.getPipelineRuns()).find((r: any) => r.id === id);
        if (run && run.logFile) resource = { ...run, lastLogPath: run.logFile };
      }

      if (resource && resource.lastLogPath) {
        try {
          await fs.access(resource.lastLogPath);
        } catch {
          await fs.mkdir(path.dirname(resource.lastLogPath), { recursive: true }).catch(() => {});
          await fs.writeFile(resource.lastLogPath, '').catch(() => {});
        }

        const tail = spawn('tail', ['-n', '0', '-f', resource.lastLogPath]);
        socketTails.set(id, tail);

        tail.stdout.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.stderr.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.on('error', (err) => {
          console.warn(`[log-tail] ${resource.lastLogPath}: ${err.message}`);
          socketTails.delete(id);
        });

        tail.on('close', () => {
          socketTails.delete(id);
        });
      }
    });

    socket.on('join-kube-room', (id) => socket.join(`${id}-kube`));
    socket.on('tail-pod', async ({ resourceId, podName, namespace }) => {
      // Same no-auth Socket.IO context as join-room above — raw DB read, not
      // appService.getAll's ownership-filtered lookup.
      const deployments = await db.getDeployments();
      const dep = deployments.find(d => d.id === resourceId);
      let context: string | undefined;
      let kubeconfigPath: string | undefined;
      if (dep) {
        // Same no-auth Socket.IO context as join-room above — raw DB read, not
        // clusterService.getById's ownership-checked lookup.
        const cluster = dep.clusterId === 'provisioning-lunorica'
          ? await clusterService.getSystemClusterEntry()
          : (await db.getClusters()).find((c: any) => c.id === dep.clusterId);
        if (cluster) {
          const isMock = clusterService.isMockCloud(cluster);
          const physicalName = clusterService.getPhysicalClusterName(cluster);
          if (cluster.provider === 'k3d' || isMock) context = `k3d-${physicalName}`;
          kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
        }
      }
      const args = ['logs', '-n', namespace || 'default', podName, '--all-containers=true', '--tail=100', '-f'];
      if (context) args.push('--context', context);
      infraService.streamLogs(resourceId, args, io, `${resourceId}-kube`, kubeconfigPath);
    });

    socket.on('leave-room', (id) => {
      socket.leave(id);
      const tail = socketTails.get(id);
      if (tail) {
        tail.kill();
        socketTails.delete(id);
      }
    });

    socket.on('leave-kube-room', (id) => { socket.leave(`${id}-kube`); infraService.stopStream(id); });

    socket.on('disconnect', () => {
      for (const tail of socketTails.values()) {
        tail.kill();
      }
      socketTails.clear();
    });
  });

  // ── 4. ROUTES ────────────────────────────────────────────────────────────

  /** ── AUTHENTICATION ── */

  app.post('/api/auth/register', async (req, res) => {
    try {
      let { email, password, inviteCode } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      // getUserByEmail (used by login, 2FA, OAuth linking, etc.) normalizes with
      // .trim().toLowerCase() before querying — pre-existing, found live while testing this
      // session's per-user isolation work: registering with any capital letter in the email
      // (e.g. "isoA@example.com") stored it as-is, so login's normalized lookup could never find
      // it again ("Invalid email or password" despite a correct password). Normalizing here too
      // keeps every path consistent instead of only patching the read side.
      email = email.trim().toLowerCase();
      const existing = await db.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const isFirstUser = (await db.getUsers()).length === 0;
      const userId = uuidv4();
      const inviteError = await checkAndConsumeInvite(inviteCode, userId, isFirstUser);
      if (inviteError) {
        return res.status(403).json({ error: inviteError });
      }

      const passHash = await hashPassword(password);
      const user = {
        id: userId,
        email,
        passwordHash: passHash,
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
        ...(isFirstUser ? { isAdmin: true } : {}),
      };
      await db.saveUser(user);
      res.json({ success: true, message: 'User registered successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const user = await db.getUserByEmail(email);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const match = await verifyPassword(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      if (user.twoFactorEnabled) {
        const code = authService.create2FAChallenge(user.id);
        await authService.send2FACode(user, code);
        return res.json({ twoFactorRequired: true, userId: user.id });
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      res.cookie('session', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
          isAdmin: user.isAdmin === true,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/2fa/verify', async (req, res) => {
    try {
      const { userId, code } = req.body;
      if (!userId || !code) {
        return res.status(400).json({ error: 'User ID and OTP code are required' });
      }
      const user = await db.getUserById(userId);
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }

      const ok = authService.verify2FAChallenge(userId, code);
      if (!ok) {
        return res.status(400).json({ error: 'Invalid or expired 2FA code' });
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      res.cookie('session', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
          isAdmin: user.isAdmin === true,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('session');
    res.json({ success: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
      id: user.id,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorPhone: user.twoFactorPhone,
      twoFactorPreferredMethod: user.twoFactorPreferredMethod,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      isAdmin: user.isAdmin === true,
    });
  });

  app.post('/api/auth/2fa/settings', async (req, res) => {
    try {
      const { enabled, phone, preferredMethod } = req.body;
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      user.twoFactorEnabled = !!enabled;
      if (phone !== undefined) user.twoFactorPhone = phone;
      if (preferredMethod !== undefined) user.twoFactorPreferredMethod = preferredMethod;

      await db.saveUser(user);
      res.json({
        id: user.id,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorPhone: user.twoFactorPhone,
        twoFactorPreferredMethod: user.twoFactorPreferredMethod,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/auth/github', (req, res) => {
    // Carries any invite code through the OAuth roundtrip via `state` — GitHub/Google echo it
    // back verbatim on the callback — so a brand-new account created via social login is
    // invite-gated exactly like native registration, not a silent bypass of it.
    const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
    const githubId = process.env.GITHUB_CLIENT_ID;
    if (!githubId) {
      return res.redirect(`http://localhost:3001/api/auth/github/callback?code=mock-github-code&state=${encodeURIComponent(invite)}`);
    }
    const redirectUri = encodeURIComponent('http://localhost:3001/api/auth/github/callback');
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${githubId}&redirect_uri=${redirectUri}&scope=user:email&state=${encodeURIComponent(invite)}`);
  });

  app.get('/api/auth/github/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      let email = 'mock-github-user@example.com';
      let idStr = 'github-mock-id';

      const githubId = process.env.GITHUB_CLIENT_ID;
      const githubSecret = process.env.GITHUB_CLIENT_SECRET;

      if (githubId && githubSecret && code !== 'mock-github-code') {
        const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
          client_id: githubId,
          client_secret: githubSecret,
          code,
        }, { headers: { Accept: 'application/json' } });
        
        const accessToken = tokenRes.data.access_token;
        if (!accessToken) throw new Error('No access token returned from GitHub');

        const userRes = await axios.get('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'provisioning-platform' },
        });

        const emailRes = await axios.get('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'provisioning-platform' },
        });

        const primaryEmailObj = emailRes.data.find((e: any) => e.primary) || emailRes.data[0];
        email = primaryEmailObj?.email || `${userRes.data.login}@github.com`;
        idStr = String(userRes.data.id);
      }

      let user = await db.getUserByEmail(email);
      if (!user) {
        const isFirstUser = (await db.getUsers()).length === 0;
        const userId = uuidv4();
        const inviteError = await checkAndConsumeInvite(typeof state === 'string' ? state : undefined, userId, isFirstUser);
        if (inviteError) {
          return res.redirect(`http://localhost:5173/?authError=${encodeURIComponent(inviteError)}`);
        }
        user = {
          id: userId,
          email,
          githubId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
          ...(isFirstUser ? { isAdmin: true } : {}),
        };
        await db.saveUser(user);
      } else if (!user.githubId) {
        user.githubId = idStr;
        await db.saveUser(user);
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      res.cookie('session', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
      res.redirect('http://localhost:5173/');
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── CLUSTER PROXY — dashboard access ── */

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
    app.get(`/api/clusters/:id/proxy/${serviceKey}`, async (req, res) => {
      try {
        const clusterId = req.params.id;
        const cluster = await clusterService.getById(clusterId, (req as any).user.id);
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

  app.get('/api/auth/google', (req, res) => {
    // See the matching comment on /api/auth/github: carries the invite code through via `state`.
    const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      return res.redirect(`http://localhost:3001/api/auth/google/callback?code=mock-google-code&state=${encodeURIComponent(invite)}`);
    }
    const redirectUri = encodeURIComponent('http://localhost:3001/api/auth/google/callback');
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code&scope=email%20profile&state=${encodeURIComponent(invite)}`);
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      let email = 'mock-google-user@example.com';
      let idStr = 'google-mock-id';

      const googleId = process.env.GOOGLE_CLIENT_ID;
      const googleSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (googleId && googleSecret && code !== 'mock-google-code') {
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
          client_id: googleId,
          client_secret: googleSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: 'http://localhost:3001/api/auth/google/callback',
        });

        const accessToken = tokenRes.data.access_token;
        if (!accessToken) throw new Error('No access token returned from Google');

        const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        email = userRes.data.email;
        idStr = String(userRes.data.id);
      }

      let user = await db.getUserByEmail(email);
      if (!user) {
        const isFirstUser = (await db.getUsers()).length === 0;
        const userId = uuidv4();
        const inviteError = await checkAndConsumeInvite(typeof state === 'string' ? state : undefined, userId, isFirstUser);
        if (inviteError) {
          return res.redirect(`http://localhost:5173/?authError=${encodeURIComponent(inviteError)}`);
        }
        user = {
          id: userId,
          email,
          googleId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
          ...(isFirstUser ? { isAdmin: true } : {}),
        };
        await db.saveUser(user);
      } else if (!user.googleId) {
        user.googleId = idStr;
        await db.saveUser(user);
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      res.cookie('session', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
      res.redirect('http://localhost:5173/');
    } catch (err: any) {
      res.status(500).send(`Google OAuth callback failed: ${err.message}`);
    }
  });

  /** ── ADMIN — invites ── */

  app.get('/api/admin/invites', requireAdmin, async (req, res) => {
    res.json(await db.getInvites());
  });

  app.post('/api/admin/invites', requireAdmin, async (req, res) => {
    const code = crypto.randomBytes(4).toString('hex');
    const invite: InviteMetadata = {
      id: code,
      code,
      createdBy: (req as any).user.id,
      createdAt: new Date().toISOString(),
    };
    await db.saveInvite(invite);
    res.status(201).json(invite);
  });

  /** ── MESH — Headscale-backed remote cluster target connectivity (distributed-systems plan Phase 1) ── */

  app.get('/api/mesh/devices', async (req, res) => {
    try {
      res.json(await headscaleService.listUserDevices((req as any).user.id));
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  app.post('/api/mesh/preauth-key', async (req, res) => {
    try {
      const reusable = req.body?.reusable === true;
      const expirySeconds = typeof req.body?.expirySeconds === 'number' ? req.body.expirySeconds : undefined;
      const key = await headscaleService.createPreAuthKey((req as any).user.id, { reusable, expirySeconds });
      res.status(201).json(key);
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  app.delete('/api/mesh/devices/:nodeId', async (req, res) => {
    try {
      // Ownership: only revoke a node this user's own Headscale namespace actually owns —
      // listUserDevices() is already scoped to req.user.id, so a foreign nodeId simply won't
      // appear in it (the same 404-not-403 pattern used for clusters/deployments).
      const devices = await headscaleService.listUserDevices((req as any).user.id);
      if (!devices.some((d) => d.id === req.params.nodeId)) {
        return res.status(404).json({ error: 'Mesh device not found' });
      }
      await headscaleService.revokeDevice(req.params.nodeId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  /** ── CREDENTIALS ── */

  const VALID_PROVIDERS = ['aws', 'gcp', 'azure', 'do', 'hetzner', 'huggingface', 'github', 'googledrive'] as const;

  /**
   * Live VPS plan/price search across providers — see VpsCatalogService for why this is queried
   * rather than hardcoded. Public catalogues (Linode, Vultr) always appear; Hetzner and
   * DigitalOcean appear once the requesting user has stored a token for them, and the `sources`
   * array explains any provider that's missing.
   */
  app.get('/api/vps-catalog', async (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
      const result = await vpsCatalogService.search((req as any).user.id, {
        ...(num(q.minRamGb) !== undefined ? { minRamGb: num(q.minRamGb)! } : {}),
        ...(num(q.maxRamGb) !== undefined ? { maxRamGb: num(q.maxRamGb)! } : {}),
        ...(num(q.minVcpu) !== undefined ? { minVcpu: num(q.minVcpu)! } : {}),
        ...(num(q.minDiskGb) !== undefined ? { minDiskGb: num(q.minDiskGb)! } : {}),
        ...(num(q.maxPriceMonthly) !== undefined ? { maxPriceMonthly: num(q.maxPriceMonthly)! } : {}),
        ...(q.location ? { location: q.location } : {}),
        ...(q.arch ? { arch: q.arch as any } : {}),
        ...(q.cpuType ? { cpuType: q.cpuType as any } : {}),
        ...(q.provider ? { provider: q.provider } : {}),
        ...(q.provisionableOnly === 'true' ? { provisionableOnly: true } : {}),
        ...(q.hourlyOnly === 'true' ? { hourlyOnly: true } : {}),
        ...(q.sort ? { sort: q.sort as any } : {}),
        ...(num(q.limit) !== undefined ? { limit: num(q.limit)! } : {}),
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Forces a re-fetch on the next search — backs the UI's Refresh button. */
  app.post('/api/vps-catalog/refresh', async (_req, res) => {
    vpsCatalogService.clearCache();
    res.json({ ok: true });
  });

  app.get('/api/credentials', async (req, res) => {
    try {
      const user = (req as any).user;
      const statuses = await credentialService.getConfiguredProviders(user.id);
      res.json({ providers: statuses });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/credentials/validate/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      // googledrive's refresh token was never typed into the form (it came from the OAuth
      // callback) so there's nothing meaningful in req.body to validate — check the stored one.
      const result = provider === 'googledrive'
        ? await credentialService.testGoogleDriveConnection(user.id)
        : await credentialService.validateCredentials(provider, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ valid: false, error: err.message });
    }
  });

  app.get('/api/credentials/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      const creds = await credentialService.getCredentials(user.id, provider);
      res.json({ provider, credentials: creds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/credentials/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      await credentialService.saveCredentials(user.id, provider, req.body);
      const updated = await credentialService.getCredentials(user.id, provider);
      res.json({ success: true, provider, credentials: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/credentials/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      await credentialService.deleteCredentials(user.id, provider);
      res.json({ success: true, provider });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── GOOGLE DRIVE (backup destination) ──
   * Separate OAuth dance from /api/auth/google (login) — same GOOGLE_CLIENT_ID/SECRET app
   * registration can serve both as long as this callback URL is also added under "Authorized
   * redirect URIs" in Google Cloud Console, and the Drive API is enabled for that project.
   * scripts/backup-to-drive.sh picks these credentials up via generate-rclone-config.ts. */

  app.get('/api/credentials/googledrive/connect', (req, res) => {
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      return res.redirect('http://localhost:5173/?driveError=missing_client_id');
    }
    const redirectUri = encodeURIComponent('http://localhost:3001/api/credentials/googledrive/callback');
    // access_type=offline + prompt=consent: without both, Google only hands back a
    // refresh_token on a user's very first-ever consent for this app — reconnecting later
    // (e.g. after a Disconnect) would silently get an access-token-only response otherwise.
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}`);
  });

  app.get('/api/credentials/googledrive/callback', async (req, res) => {
    try {
      const { code } = req.query;
      const googleId = process.env.GOOGLE_CLIENT_ID;
      const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!googleId || !googleSecret) {
        return res.redirect('http://localhost:5173/?driveError=missing_client_id');
      }

      const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: googleId,
        client_secret: googleSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: 'http://localhost:3001/api/credentials/googledrive/callback',
      });

      const refreshToken = tokenRes.data.refresh_token;
      const accessToken = tokenRes.data.access_token;
      if (!refreshToken) {
        // Happens if the user had already granted consent before and Google didn't re-issue a
        // refresh_token despite prompt=consent (rare, but possible with cached grants) — send
        // them to revoke access at myaccount.google.com/permissions and try again.
        return res.redirect('http://localhost:5173/?driveError=no_refresh_token');
      }

      const aboutRes = await axios.get('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const email = aboutRes.data.user?.emailAddress || '';

      const user = (req as any).user;
      await credentialService.saveCredentials(user.id, 'googledrive', { refreshToken, email });
      res.redirect('http://localhost:5173/?driveConnected=1');
    } catch (err: any) {
      res.redirect(`http://localhost:5173/?driveError=${encodeURIComponent(err.message)}`);
    }
  });

  app.post('/api/backup/run', async (req, res) => {
    const script = path.join(__dirname, '../../../scripts/backup-to-drive.sh');
    const child = spawn('bash', [script], { cwd: path.join(__dirname, '../../..') });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('close', (exitCode) => {
      res.json({ success: exitCode === 0, output });
    });
    child.on('error', (err) => {
      res.status(500).json({ success: false, output: output + `\n${err.message}` });
    });
  });

  /** ── CLUSTERS ── */

  app.get('/api/clusters', async (req, res) => res.json(await clusterService.getAll((req as any).user.id, io)));

  app.post('/api/clusters', async (req, res) => {
    try {
      const remote = req.body.provider === 'remote'
        ? {
            host: req.body.remoteHost,
            username: req.body.remoteUsername,
            privateKey: req.body.remoteSshPrivateKey,
            ...(typeof req.body.remoteSshPort === 'number' ? { port: req.body.remoteSshPort } : {}),
            ...(typeof req.body.remoteK3sApiPort === 'number' ? { k3sApiPort: req.body.remoteK3sApiPort } : {}),
          }
        : undefined;
      if (remote && (!remote.host || !remote.username || !remote.privateKey)) {
        return res.status(400).json({ error: 'remoteHost, remoteUsername, and remoteSshPrivateKey are required for provider "remote"' });
      }
      const hetzner = req.body.provider === 'hetzner'
        ? {
            ...(req.body.hetznerServerType ? { serverType: String(req.body.hetznerServerType) } : {}),
            ...(req.body.hetznerLocation ? { location: String(req.body.hetznerLocation) } : {}),
            ...(req.body.hetznerImage ? { image: String(req.body.hetznerImage) } : {}),
          }
        : undefined;
      const info = await temporalBridge.provision(req.body.name, req.body.provider, (req as any).user.id, remote, hetzner);
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

  app.delete('/api/clusters/:id', async (req, res) => {
    if (req.params.id === 'provisioning-lunorica') {
      return res.status(403).json({ error: 'The system management cluster cannot be destroyed' });
    }
    try {
      const cluster = await clusterService.getById(req.params.id, (req as any).user.id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
      clusterProxyService.stopForCluster(req.params.id);
      if (cluster.status === 'provisioning') {
        await clusterService.abort(req.params.id, (req as any).user.id, io);
        return res.json({ success: true, message: 'Cluster provisioning aborted' });
      }
      const info = await temporalBridge.destroyCluster(req.params.id);
      res.status(202).json({
        message: 'Destroying cluster',
        clusterId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      // Fallback to clusterService.delete or abort
      try {
        await clusterService.abort(req.params.id, (req as any).user.id, io);
        res.json({ success: true, message: 'Cluster deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Cluster destruction unavailable: ${err.message}` });
      }
    }
  });

  app.post('/api/clusters/discover', async (req, res) => {
    try {
      const discovered = await clusterService.discoverClusters((req as any).user.id);
      res.json({ clusters: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/clusters/:id/discover-deployments', async (req, res) => {
    try {
      const discovered = await appService.discoverDeployments(req.params.id, (req as any).user.id);
      res.json({ deployments: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/clusters/:id/all-pods', async (req, res) => res.json(await clusterService.listAllPods(req.params.id, (req as any).user.id)));
  app.get('/api/clusters/:id/helm-releases', async (req, res) => res.json(await clusterService.listReleases(req.params.id, (req as any).user.id)));
  app.get('/api/clusters/:id/gpu-status', async (req, res) => res.json(await clusterService.getGpuStatus(req.params.id, (req as any).user.id)));

  app.get('/api/clusters/:id/services', async (req, res) => {
    try {
      const cluster = await clusterService.getById(req.params.id, (req as any).user.id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const releases = await clusterService.listReleases(req.params.id, (req as any).user.id);
      const pods = await clusterService.listAllPods(req.params.id, (req as any).user.id);

      // Grafana ships as a subchart *inside* the kube-prometheus-stack release (see
      // constructs/monitoring.ts: grafana.enabled=true), not its own separate Helm release —
      // matching only 'kube-prometheus-stack-grafana' here would never find a release and
      // always show "Not Installed" even when Grafana is actually running. Separate from
      // POD_NAME_PATTERNS below: this is only for the installed/status/chart/version fields,
      // not which pods list under each card — sharing one list for both would make Prometheus
      // and Grafana's cards show each other's pods too. Confirmed live.
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
        // one combined card (imperfect if exactly one of the two is down, acceptable for a
        // status card, not a health check).
        loki: ['loki', 'promtail'],
      };
      const POD_NAME_PATTERNS: Record<string, string[]> = {
        // Not 'alertmanager-kube-prometheus-stack' anymore — that now belongs solely to the
        // dedicated 'alertmanager' card below (same reasoning as Grafana already having its own
        // separate list: sharing pod patterns between two cards makes them show each other's
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

  /** ── DEPLOYMENTS ── */

  app.get('/api/deployments', async (req, res) => res.json(await appService.getAll((req as any).user.id, io)));

  app.post('/api/deployments', async (req, res) => {
    try {
      const user = (req as any).user;
      const targetCluster = await clusterService.getById(req.body.clusterId, user.id);
      if (!targetCluster) return res.status(404).json({ error: 'Cluster not found' });
      const info = await temporalBridge.deployApp(req.body, user?.id);
      res.status(202).json({
        message: 'Deployment started',
        deploymentName: req.body.name,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal app deploy unavailable: ${err.message}` });
    }
  });

  // No standalone POST .../abort route — same reasoning as clusters above: DELETE already
  // checks dep.status === 'deploying' and calls appService.abort() itself.

  app.delete('/api/deployments/:id', async (req, res) => {
    try {
      const dep = await appService.getById(req.params.id, (req as any).user.id);
      if (!dep) return res.status(404).json({ error: 'Deployment not found' });
      if (dep.status === 'deploying') {
        await appService.abort(req.params.id, (req as any).user.id, io);
        return res.json({ success: true, message: 'Deployment aborted' });
      }
      const info = await temporalBridge.destroyApp(req.params.id);
      res.status(202).json({
        message: 'Destroying app',
        deploymentId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      try {
        await appService.abort(req.params.id, (req as any).user.id, io);
        res.json({ success: true, message: 'Deployment deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Deployment destruction unavailable: ${err.message}` });
      }
    }
  });

  app.get('/api/deployments/:id/helm', async (req, res) => res.json({ content: await appService.getHelmStatus(req.params.id, (req as any).user.id) }));
  app.get('/api/deployments/:id/diagnostics', async (req, res) => res.json({ content: await appService.getDiagnostics(req.params.id, (req as any).user.id) }));
  app.get('/api/deployments/:id/pods', async (req, res) => {
    try { res.json(await appService.listPods(req.params.id, (req as any).user.id)); } catch { res.status(500).json({ error: 'Failed to list pods' }); }
  });

  app.post('/api/deployments/:id/expose', async (req, res) => {
    try {
      const dep = await appService.getById(req.params.id, (req as any).user.id);
      if (!dep) return res.status(404).json({ error: 'Deployment not found' });
      // The whole exposure path is HTTP — Traefik by Host header, then an HTTPS localtunnel. For a
      // UDP game server it would build a working tunnel to nothing, so refuse rather than hand
      // back a URL that can never carry game traffic. The UI hides the control too; this is the
      // guard for a direct API call.
      if (NO_WEB_UI_APP_TYPES.has(dep.appType ?? '')) {
        return res.status(400).json({
          error: `"${dep.appType}" has no HTTP interface to expose — players connect directly to the cluster node on its game port.`,
        });
      }
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.exposeLocal(req.params.id) : await appExposureService.exposePublic(req.params.id);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/deployments/:id/unexpose', async (req, res) => {
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.unexposeLocal(req.params.id) : await appExposureService.unexposePublic(req.params.id);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/deployments/:id/exposure-path', async (req, res) => {
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      const { path } = req.body;
      res.json(await appExposureService.updateExposurePath(req.params.id, path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── PROJECTS (CI/CD: sibling repos hosted on the self-hosted Gitea) ── */

  app.get('/api/projects', async (req, res) => res.json(await db.getProjects()));

  app.get('/api/projects/:id/runs', async (req, res) => {
    const runs = await db.getPipelineRuns();
    res.json(runs.filter((r: any) => r.projectId === req.params.id).sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt)));
  });

  app.post('/api/projects', async (req, res) => {
    try {
      const { name, giteaOwner, giteaRepo, createRepo, targetClusterId, targetNamespace, autoDeployOnBuild } = req.body;
      if (!name || !giteaRepo) return res.status(400).json({ error: 'name and giteaRepo are required' });
      const owner = giteaOwner || giteaService.adminUsername;

      if (createRepo) {
        await giteaService.createRepo(giteaRepo, { description: `Provisioning project: ${name}` });
      } else {
        await giteaService.getRepo(owner, giteaRepo); // throws if it doesn't exist / isn't reachable
      }

      const id = uuidv4();
      const webhookSecret = crypto.randomBytes(32).toString('hex');

      // Gitea's webhook delivery needs a URL reachable from inside its pod, back out to this
      // backend process on the host — the node's own LAN IP (this platform's management
      // cluster is native k3s, sharing the host's network stack, not a nested Docker container
      // like AppExposureService's k3d-server-container case) is the one address guaranteed to
      // work in both directions on this platform's actual (Linux) deployment target.
      // A dual-stack node reports multiple InternalIP entries (IPv4 + IPv6) — jsonpath's
      // filter returns all of them space-joined, not just one. Confirmed live: this produced a
      // malformed multi-address URL Gitea rejected outright. The IPv4 address is always first.
      const nodeIpRaw = (await infraService.runKubectl(
        ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
        '/tmp/kubeconfig-provisioning-lunorica',
      )).trim();
      const nodeIp = nodeIpRaw.split(/\s+/)[0];
      const backendPort = process.env.PORT || 3001;
      await giteaService.createWebhook(owner, giteaRepo, `http://${nodeIp}:${backendPort}/webhooks/gitea/${id}`, webhookSecret);

      const project = await db.saveProjectInfo({
        id,
        name,
        giteaOwner: owner,
        giteaRepo,
        appType: 'gitapp',
        ...(targetClusterId ? { targetClusterId } : {}),
        ...(targetNamespace ? { targetNamespace } : {}),
        autoDeployOnBuild: autoDeployOnBuild === true,
        webhookSecretEnc: encryptValue(webhookSecret, JWT_SECRET),
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:id/runs/:runId/promote', async (req, res) => {
    try {
      const projects = await db.getProjects();
      const project = projects.find((p: any) => p.id === req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const runs = await db.getPipelineRuns();
      const run = runs.find((r: any) => r.id === req.params.runId && r.projectId === project.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });

      const user = (req as any).user;
      const info = await temporalBridge.promoteProjectBuild(project, run, user?.id);
      res.status(202).json({ message: 'Promoting build to deployment', workflowId: info.id, deploymentId: info.resourceId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** ── MODULES ── */
  app.get('/api/modules', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string)));

  /**
   * Settings schema for app types whose configuration is schema-driven rather than a handful of
   * first-class fields (see lib/app-settings-schema.ts). The frontend's Config tab renders itself
   * from this, so a new setting is a one-file backend change with no matching UI edit.
   *
   * Served over HTTP rather than shared as a module because there is no cross-workspace source
   * package here — adding one would mean rebuilding the in-cluster worker image too.
   */
  app.get('/api/app-schemas/:appType', async (req, res) => {
    const schema = APP_SETTINGS_SCHEMAS[req.params.appType];
    if (!schema) return res.status(404).json({ error: `No settings schema for app type "${req.params.appType}"` });
    return res.json(schema);
  });

  app.patch('/api/deployments/:id/modules', async (req, res) => {
    const { modules } = req.body;
    res.status(202).json(await appService.updateModules(req.params.id, modules, (req as any).user.id, io));
  });

  app.patch('/api/deployments/:id/storage', async (req, res) => {
    // Delegated to TemporalBridge (manual resize)
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      const info = await temporalBridge.resizeDisk(req.params.id, req.body.storage);
      res.status(202).json({
        message: 'Resize started',
        deploymentId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal resize disk unavailable: ${err.message}` });
    }
  });

  app.patch('/api/deployments/:id/config', async (req, res) => {
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      // Allowlist rather than trusting req.body wholesale — this reaches saveDeploymentInfo(),
      // and fields like status/temporalWorkflowId are internal state a client should never be
      // able to overwrite directly.
      const CONFIGURABLE_FIELDS = [
        'storage', 'webRepo', 'webTag', 'dbRepo', 'dbTag',
        'vllmModel', 'vllmGpuCount', 'vllmGpuVendor', 'vllmCachePvc', 'vllmHfToken',
        'vllmMaxModelLen', 'vllmGpuMemUtil', 'vllmExtraArgs', 'openWebuiTargetId',
        'vllmToolCallingEnabled', 'vllmToolCallParser', 'vllmServedModelName',
        'vllmMaxNumSeqs', 'vllmDtype', 'vllmEnablePrefixCaching',
        'tabbyModel', 'tabbyRevision', 'tabbyGpuCount', 'tabbyHfToken', 'tabbyCachePvc',
        'tabbyImageTag', 'tabbyCacheMode', 'tabbyMaxSeqLen', 'tabbyMaxBatchSize',
        'tabbyReasoning', 'tabbyToolFormat', 'tabbyInlineModelLoading', 'tabbyDisableAuth',
        'tabbyExtraEnv',
        'webuiEnableWebSearch', 'webuiWebSearchEngine', 'webuiWebSearchApiKey',
        // Map-valued: deep-merged in updateConfigAndSync and key-validated against the app's
        // schema below, since these become container env vars.
        'appSettings',
      ];
      const patch: Record<string, any> = {};
      for (const key of CONFIGURABLE_FIELDS) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }

      // The allowlist above gates FIELD names; it says nothing about the KEYS inside appSettings —
      // and those become container environment variables. Without this, any authenticated user
      // could inject arbitrary env (LD_PRELOAD and friends) into a pod. Validated here rather
      // than in the activity so the caller gets a synchronous 400 instead of a workflow that
      // fails minutes later.
      if (patch.appSettings !== undefined) {
        const existing = await appService.getById(req.params.id, (req as any).user.id);
        const schema = APP_SETTINGS_SCHEMAS[existing?.appType ?? ''];
        if (!schema) {
          return res.status(400).json({ error: `App type "${existing?.appType}" has no settings schema` });
        }
        const { values, errors } = validateAppSettings(schema, patch.appSettings);
        if (errors.length > 0) {
          return res.status(400).json({ error: 'Invalid settings', details: errors });
        }
        patch.appSettings = values;
      }

      const info = await temporalBridge.updateConfigAndSync(req.params.id, patch);
      res.status(202).json({
        message: 'Config updated, sync started',
        deploymentId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal config update unavailable: ${err.message}` });
    }
  });

  /** ── REGISTRY ── */
  app.get('/api/registry/search', async (req, res) => res.json(await registryService.search(req.query.q as string)));
  app.get('/api/registry/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));
  app.get('/api/registry/local-tags', async (req, res) => res.json(await registryService.getLocalTags(req.query.repo as string)));

  // Lets the wizard show a model's real download size before deploying, instead of the
  // deploy-time regex guess in tabbyapi.ts (used only as a fallback there when this wasn't
  // available, e.g. an unusual repo name) — see DownloadModelActivity.ts for the shared file
  // -listing helper this also uses for the actual pre-download. Also estimates GPU VRAM (weight
  // shard + KV cache) for the requested context length/cache mode/GPU count, since that's a
  // separate concern from the download size and from the host-side shm/memory sizing tabbyapi.ts
  // does — see huggingface.ts's estimateKvCacheBytes for why this is informational, not a hard
  // validation gate (K8s' nvidia device plugin lets you request a GPU count, not a VRAM amount).
  app.get('/api/models/hf-size', async (req, res) => {
    try {
      const repo = req.query.repo as string;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const revision = req.query.revision as string | undefined;
      const user = (req as any).user;
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const size = await getHfModelSize(repo, revision, resolved.env.HF_TOKEN);

      const maxSeqLen = req.query.maxSeqLen ? parseInt(req.query.maxSeqLen as string) : undefined;
      const gpuCount = Math.max(parseInt((req.query.gpuCount as string) || '1'), 1);
      let kvCacheBytesPerGpu: number | undefined;
      let weightBytesPerGpu: number | undefined;
      if (maxSeqLen) {
        try {
          const config = await getHfModelConfig(repo, revision, resolved.env.HF_TOKEN);
          kvCacheBytesPerGpu = estimateKvCacheBytes(config, maxSeqLen, req.query.cacheMode as string | undefined) / gpuCount;
          weightBytesPerGpu = size.totalBytes / gpuCount;
        } catch {
          // config.json missing/unparseable shouldn't block showing the download size — VRAM
          // estimate just gets omitted.
        }
      }

      res.json({ ...size, kvCacheBytesPerGpu, weightBytesPerGpu });
    } catch (err: any) {
      res.status(500).json({ error: err.response?.status === 404 ? `Model or revision not found: ${req.query.repo}@${req.query.revision || 'main'}` : err.message });
    }
  });

  // Backs the wizard's model picker for vLLM/TabbyAPI — an empty q still returns something
  // useful (top-downloaded results) rather than nothing, replacing what used to be a static
  // hardcoded list of 4-5 models baked into the frontend. TabbyAPI only runs EXL3 quants, so its
  // results come from turboderp's curated exl3-models collection instead of generic search —
  // see getExl3ModelCollection's own comment for why.
  app.get('/api/models/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const appType = req.query.appType as string;
      const results = appType === 'tabbyapi'
        ? await getExl3ModelCollection(q)
        : await searchHfModels(q, { ...(appType === "vllm" ? { pipelineTag: "text-generation" } : {}), limit: 20 });
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lets the wizard show which bits-per-weight branches actually exist for a picked model —
  // see getHfModelBranches's own comment for why this is a separate lookup from the model
  // picker itself (EXL2/EXL3 quants split bpw variants across branches of one repo).
  app.get('/api/models/hf-branches', async (req, res) => {
    try {
      const repo = req.query.repo as string;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const user = (req as any).user;
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const branches = await getHfModelBranches(repo, resolved.env.HF_TOKEN);
      res.json(branches);
    } catch (err: any) {
      res.status(500).json({ error: err.response?.status === 404 ? `Model not found: ${req.query.repo}` : err.message });
    }
  });

  /** ── NGINX config ── */
  const NGINX_CONF_PATH = path.join(__dirname, '../data/nginx/nginx.conf');

  app.get('/api/nginx/config', async (req, res) => {
    try { res.json({ content: await fs.readFile(NGINX_CONF_PATH, 'utf-8') }); }
    catch (err: any) { res.status(500).json({ error: `Failed to read nginx config: ${err.message}` }); }
  });

  app.post('/api/nginx/config', async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'Config content must be a string' });
      await fs.writeFile(NGINX_CONF_PATH, content);

      const execAsync = (await import('util')).promisify((await import('child_process')).exec);
      await execAsync('docker exec provisioner-nginx nginx -s reload');
      res.json({ message: 'Nginx config updated and reloaded successfully' });
    } catch (err: any) { res.status(500).json({ error: `Failed to update nginx config: ${err.message}` }); }
  });

  /** ── LOGS ── */
  app.get('/api/logs/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const resource = type === 'cluster'
      ? await clusterService.getById(id, (req as any).user.id)
      : type === 'pipeline'
      ? (await db.getPipelineRuns()).find((r: any) => r.id === id)
      : (await appService.getAll((req as any).user.id)).find((d: any) => d.id === id);
    const logPath = type === 'pipeline' ? (resource as any)?.logFile : (resource as any)?.lastLogPath;
    if (!resource || !logPath) return res.json({ content: 'Initializing...' });
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      res.json({ content });
    }
    catch {
      res.json({ content: 'Waiting for logs...' });
    }
  });

  /** ── TEMPORAL — monitoring ── */

  app.get('/api/temporal/status', async (req, res) => {
    const ready = temporalBridge.isReady();
    let version: string | undefined;
    if (ready) {
      try {
        const svc = (temporalBridge as any).client.workflowService;
        const info = await svc?.getSystemInfo?.();
        version = info?.serverVersion;
      } catch {}
    }
    res.json({ connected: ready, serverVersion: version });
  });

  app.get('/api/temporal/workflows', async (req, res) => {
    const query = req.query.query as string | undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 50;
    const workflows = await temporalBridge.listWorkflows(query, pageSize);
    res.json({ workflows });
  });

  app.get('/api/temporal/workflows/count', async (req, res) => {
    const [total, running, completed, failed, timedOut] = await Promise.all([
      temporalBridge.countWorkflows(''),
      temporalBridge.countWorkflows('ExecutionStatus="Running"'),
      temporalBridge.countWorkflows('ExecutionStatus="Completed"'),
      temporalBridge.countWorkflows('ExecutionStatus="Failed"'),
      temporalBridge.countWorkflows('ExecutionStatus="TimedOut"'),
    ]);
    res.json({ total, running, completed, failed, timedOut });
  });

  app.get('/api/temporal/workflows/:workflowId', async (req, res) => {
    const workflow = await temporalBridge.describeWorkflow(req.params.workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ workflow });
  });

  app.get('/api/temporal/workflows/:workflowId/history', async (req, res) => {
    const events = await temporalBridge.getWorkflowHistory(req.params.workflowId);
    if (!events) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ events });
  });

  /** ── INIT ── */
  if (process.env.NODE_ENV !== 'test') {
    appExposureService.syncExposedApps().catch((e) => {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`Failed to sync exposed apps to nginx: ${err}`);
    });
  }

  // ── WORKER ──

  const workerService = new WorkerService();

  app.post('/api/worker', async (req, res) => {
    try {
      const { clusterId, context } = req.body || {};
      if (!clusterId) return res.status(400).json({ error: 'clusterId is required' });
      console.log(`[Worker] Initialized worker ${clusterId} (context: ${context || 'local'})`);
      res.status(202).json({
        message: 'Worker initialized',
        clusterId,
        context: context || 'local',
        state: 'running',
      });
    } catch (err: any) {
      console.error(`[Worker] Failed to initialize: ${err.message}`);
      res.status(503).json({ error: err.message });
    }
  });

  app.delete('/api/worker', async (req, res) => {
    try {
      console.log('[Worker] Worker stopped');
      res.status(200).json({ message: 'Worker stopped' });
    } catch (err: any) {
      console.error(`[Worker] Failed to stop: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/worker', async (req, res) => {
    try {
      const state = workerService.status();
      res.json({
        clusterId: state?.clusterId || '',
        context: state?.context || 'local',
        state: state?.state || 'stopped',
        running: state?.state === 'running',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  if (process.env.NODE_ENV !== 'test' || process.env.IS_E2E === 'true') {
    const hostTunnelPort = process.env.IS_E2E === 'true' ? 8001 : 8000;
    startHostTunnel(hostTunnelPort);
    httpServer.listen(port, () => console.log(`🚀 Provisioning Server Active on http://localhost:${port}`));
  }

  const shutdown = () => { clusterProxyService.stopAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, io, temporalBridge };
}

if (process.env.NODE_ENV !== 'test' || process.env.IS_E2E === 'true') {
  bootstrap().catch(console.error);
}
