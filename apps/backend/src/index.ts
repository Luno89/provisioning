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

// Service Imports
import { InfrastructureService } from './services/InfrastructureService.js';
import { ClusterService } from './services/ClusterService.js';
import { AppService } from './services/AppService.js';
import { RegistryService } from './services/RegistryService.js';
import { GitModuleService } from './services/GitModuleService.js';
import { BuilderService } from './services/BuilderService.js';
import { AppExposureService } from './services/AppExposureService.js';
import type { ClusterMetadata, DeploymentMetadata } from './lib/types.js';
import { TemporalBridge } from './services/TemporalBridge.js';
import WorkerService from './services/WorkerService.js';
import { ClusterProxyService } from './services/ClusterProxyService.js';
import net from 'net';
import { spawn } from 'child_process';
import axios from 'axios';
import { signJWT, verifyJWT, hashPassword, verifyPassword } from './lib/auth.js';
import { AuthService } from './services/AuthService.js';
import { CredentialService } from './services/CredentialService.js';
import type { CloudProvider } from './lib/types.js';

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

  const infraService = new InfrastructureService();
  const builderService = new BuilderService(db, infraService);
  const clusterService = new ClusterService(db, infraService);
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);
  const appExposureService = new AppExposureService(db, infraService, clusterService, io);
  const clusterProxyService = new ClusterProxyService();
  const JWT_SECRET = process.env.JWT_SECRET || 'provisioning-platform-secret-12345';

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
  app.use(express.json());
  const credentialService = new CredentialService(db, JWT_SECRET);

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

      const resource = (await clusterService.getById(id)) || 
                       (await appService.getAll()).find((d: any) => d.id === id);

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
      const deployments = await appService.getAll();
      const dep = deployments.find(d => d.id === resourceId);
      let context: string | undefined;
      let kubeconfigPath: string | undefined;
      if (dep) {
        const cluster = await clusterService.getById(dep.clusterId);
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
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const existing = await db.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: 'User already exists' });
      }
      const passHash = await hashPassword(password);
      const user = {
        id: uuidv4(),
        email,
        passwordHash: passHash,
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
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
    const githubId = process.env.GITHUB_CLIENT_ID;
    if (!githubId) {
      return res.redirect('http://localhost:3001/api/auth/github/callback?code=mock-github-code');
    }
    const redirectUri = encodeURIComponent('http://localhost:3001/api/auth/github/callback');
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${githubId}&redirect_uri=${redirectUri}&scope=user:email`);
  });

  app.get('/api/auth/github/callback', async (req, res) => {
    try {
      const { code } = req.query;
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
        user = {
          id: uuidv4(),
          email,
          githubId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
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

  const PROXY_SERVICES = ['prometheus', 'grafana', 'traefik'] as const;

  for (const serviceKey of PROXY_SERVICES) {
    app.get(`/api/clusters/:id/proxy/${serviceKey}`, async (req, res) => {
      try {
        const clusterId = req.params.id;
        const cluster = await clusterService.getById(clusterId);
        if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

        const kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
        const targetUrl = await clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath);

        res.setHeader('Content-Type', 'text/html');
        res.send(`<!DOCTYPE html><html><head><title>${serviceKey}</title></head><body style="margin:0"><iframe src="${targetUrl}" style="width:100%;height:100vh;border:none"></iframe></body></html>`);
      } catch (err: any) {
        res.status(502).json({ error: `Service unavailable: ${err.message}` });
      }
    });
  }

  app.get('/api/auth/google', (req, res) => {
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      return res.redirect('http://localhost:3001/api/auth/google/callback?code=mock-google-code');
    }
    const redirectUri = encodeURIComponent('http://localhost:3001/api/auth/google/callback');
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code&scope=email%20profile`);
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    try {
      const { code } = req.query;
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
        user = {
          id: uuidv4(),
          email,
          googleId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
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

  /** ── CREDENTIALS ── */

  const VALID_PROVIDERS = ['aws', 'gcp', 'azure', 'do', 'huggingface', 'github'] as const;

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
      const result = await credentialService.validateCredentials(provider, req.body);
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

  /** ── CLUSTERS ── */

  app.get('/api/clusters', async (req, res) => res.json(await clusterService.getAll(io)));

  app.post('/api/clusters', async (req, res) => {
    try {
      const info = await temporalBridge.provision(req.body.name, req.body.provider);
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

  app.post('/api/clusters/:id/abort', async (req, res) => {
    try {
      await clusterService.abort(req.params.id, io);
      res.json({ success: true, message: 'Cluster provisioning abort initiated' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/clusters/:id', async (req, res) => {
    if (req.params.id === 'provisioning-lunorica') {
      return res.status(403).json({ error: 'The system management cluster cannot be destroyed' });
    }
    try {
      clusterProxyService.stopForCluster(req.params.id);
      const cluster = await clusterService.getById(req.params.id);
      if (cluster && cluster.status === 'provisioning') {
        await clusterService.abort(req.params.id, io);
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
        await clusterService.abort(req.params.id, io);
        res.json({ success: true, message: 'Cluster deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Cluster destruction unavailable: ${err.message}` });
      }
    }
  });

  app.post('/api/clusters/discover', async (req, res) => {
    try {
      const discovered = await clusterService.discoverClusters();
      res.json({ clusters: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/clusters/:id/discover-deployments', async (req, res) => {
    try {
      const discovered = await appService.discoverDeployments(req.params.id);
      res.json({ deployments: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/clusters/:id/all-pods', async (req, res) => res.json(await clusterService.listAllPods(req.params.id)));
  app.get('/api/clusters/:id/helm-releases', async (req, res) => res.json(await clusterService.listReleases(req.params.id)));
  app.get('/api/clusters/:id/gpu-status', async (req, res) => res.json(await clusterService.getGpuStatus(req.params.id)));

  app.get('/api/clusters/:id/services', async (req, res) => {
    try {
      const cluster = await clusterService.getById(req.params.id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const releases = await clusterService.listReleases(req.params.id);
      const pods = await clusterService.listAllPods(req.params.id);

      const SERVICE_NAMES: Record<string, string[]> = {
        prometheus: ['kube-prometheus-stack', 'prometheus-server', 'prometheus'],
        grafana: ['kube-prometheus-stack-grafana', 'grafana'],
        traefik: ['traefik'],
      };

      const services = Object.entries(SERVICE_NAMES).map(([serviceKey, chartNames]) => {
        const release = releases.find((r: any) => chartNames.includes(r.name));
        const namespace = serviceKey === 'traefik' ? 'kube-system' : 'monitoring';
        const servicePods = Array.isArray(pods) ? pods.filter((p: any) =>
          p?.metadata?.namespace === namespace &&
          chartNames.some(name => (p?.metadata?.name || '').includes(name))
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

  app.get('/api/deployments', async (req, res) => res.json(await appService.getAll(io)));

  app.post('/api/deployments', async (req, res) => {
    try {
      const user = (req as any).user;
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

  app.post('/api/deployments/:id/abort', async (req, res) => {
    try {
      await appService.abort(req.params.id, io);
      res.json({ success: true, message: 'App deployment abort initiated' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/deployments/:id', async (req, res) => {
    try {
      const dep = await appService.getById(req.params.id);
      if (dep && dep.status === 'deploying') {
        await appService.abort(req.params.id, io);
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
        await appService.abort(req.params.id, io);
        res.json({ success: true, message: 'Deployment deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Deployment destruction unavailable: ${err.message}` });
      }
    }
  });

  app.get('/api/deployments/:id/helm', async (req, res) => res.json({ content: await appService.getHelmStatus(req.params.id) }));
  app.get('/api/deployments/:id/diagnostics', async (req, res) => res.json({ content: await appService.getDiagnostics(req.params.id) }));
  app.get('/api/deployments/:id/pods', async (req, res) => {
    try { res.json(await appService.listPods(req.params.id)); } catch { res.status(500).json({ error: 'Failed to list pods' }); }
  });

  app.post('/api/deployments/:id/expose', async (req, res) => {
    try {
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.exposeLocal(req.params.id) : await appExposureService.exposePublic(req.params.id);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/deployments/:id/unexpose', async (req, res) => {
    try {
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.unexposeLocal(req.params.id) : await appExposureService.unexposePublic(req.params.id);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/deployments/:id/exposure-path', async (req, res) => {
    try {
      const { path } = req.body;
      res.json(await appExposureService.updateExposurePath(req.params.id, path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── MODULES ── */
  app.get('/api/modules', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string)));

  app.patch('/api/deployments/:id/modules', async (req, res) => {
    const { modules } = req.body;
    res.status(202).json(await appService.updateModules(req.params.id, modules, io));
  });

  app.patch('/api/deployments/:id/storage', async (req, res) => {
    // Delegated to TemporalBridge (manual resize)
    try {
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
      // Allowlist rather than trusting req.body wholesale — this reaches saveDeploymentInfo(),
      // and fields like status/temporalWorkflowId are internal state a client should never be
      // able to overwrite directly.
      const CONFIGURABLE_FIELDS = [
        'storage', 'webRepo', 'webTag', 'dbRepo', 'dbTag',
        'vllmModel', 'vllmGpuCount', 'vllmGpuVendor', 'vllmCachePvc', 'vllmHfToken',
        'vllmMaxModelLen', 'vllmGpuMemUtil', 'vllmExtraArgs', 'openWebuiTargetId',
        'vllmToolCallingEnabled', 'vllmToolCallParser', 'vllmServedModelName',
        'vllmMaxNumSeqs', 'vllmDtype', 'vllmEnablePrefixCaching',
      ];
      const patch: Record<string, any> = {};
      for (const key of CONFIGURABLE_FIELDS) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
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
      ? await clusterService.getById(id)
      : (await appService.getAll()).find((d: any) => d.id === id);
    if (!resource || !resource.lastLogPath) return res.json({ content: 'Initializing...' });
    try {
      const content = await fs.readFile(resource.lastLogPath, 'utf-8');
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
