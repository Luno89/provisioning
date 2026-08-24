import { Router, type Request } from 'express';
import crypto from 'crypto';
import { encryptValue } from '../lib/crypto.js';
import { asyncRoute } from '../middleware/async-route.js';
import { isWorkspaceLanguage } from '../lib/workspace-spec.js';
import { v4 as uuidv4 } from 'uuid';
import { ownsProject } from '../lib/ownership.js';
import { rollupProjectStatus, deploymentForProject } from '../lib/project-status.js';
import { webhookUrlFor } from '../lib/project-shipping.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Projects: a repo on the self-hosted Gitea, and whatever has been deployed from it.
 */
export function projectsRouter(deps: Record<string, any>): Router {
  const {
    db, projectRepoService, appService, temporalBridge, getOwnedProject,
    giteaService, clusterService, infraService, jwtSecret,
  } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const projects = await db.getProjects();
    const mine = projects.filter((p: any) => ownsProject(p, userOf(req)));
    /**
     * Each project carries its end-to-end verdict, derived here rather than in the UI.
     *
     * The list previously showed `lastBuildStatus`, so a project could read "succeeded" while the
     * pod its image was promoted into had been crashlooping for an hour — "built" was being shown
     * where people read "works". The rule for what counts as healthy lives in one place because a
     * Koala branch asks the same question about the same project.
     */
    const [runs, deployments] = await Promise.all([db.getPipelineRuns(), db.getDeployments()]);
    res.json(mine.map((p: any) => ({
      ...p,
      ...rollupProjectStatus(p, runs, deploymentForProject(p, deployments)),
    })));
  });

  router.get('/:id/runs', async (req, res) => {
    if (!(await getOwnedProject(req.params.id, userOf(req)))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const runs = await db.getPipelineRuns();
    res.json(runs.filter((r: any) => r.projectId === req.params.id).sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt)));
  });

  router.post('/', async (req, res) => {
    try {
      const { name, giteaOwner, giteaRepo, createRepo, targetClusterId, targetNamespace, autoDeployOnBuild, language } = req.body;
      if (!name || !giteaRepo) return res.status(400).json({ error: 'name and giteaRepo are required' });

      // A NEW repository is created under the requesting user's own Gitea account, not the shared
      // admin one. That is what makes a sandbox push token safe to hand out: its reach is one
      // user's repositories rather than every tenant's. Registering an EXISTING repo still honours
      // an explicit owner, so the pipeline projects that predate per-user accounts keep working.
      let owner = giteaOwner || giteaService.adminUsername;

      if (createRepo) {
        const account = await projectRepoService.ensureAccountFor(userOf(req).id);
        owner = account.username;
        await giteaService.createRepoForUser(owner, giteaRepo, { description: `Provisioning project: ${name}` });
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
      // Shared with the agent's own path, which had none of this — see lib/project-shipping.ts.
      await giteaService.createWebhook(owner, giteaRepo, webhookUrlFor(nodeIpRaw, process.env.PORT || 3001, id), webhookSecret);

      const project = await db.saveProjectInfo({
        id,
        name,
        giteaOwner: owner,
        giteaRepo,
        ownerId: userOf(req).id,
        // What the CODE needs. Every persona working in this repository gets it, which is why it
        // is recorded here rather than on any of them.
        ...(isWorkspaceLanguage(language) ? { language } : {}),
        appType: 'gitapp',
        ...(targetClusterId ? { targetClusterId } : {}),
        ...(targetNamespace ? { targetNamespace } : {}),
        autoDeployOnBuild: autoDeployOnBuild === true,
        webhookSecretEnc: encryptValue(webhookSecret, jwtSecret),
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/runs/:runId/promote', async (req, res) => {
    try {
      const user = userOf(req);
      const project = await getOwnedProject(req.params.id, user);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const runs = await db.getPipelineRuns();
      const run = runs.find((r: any) => r.id === req.params.runId && r.projectId === project.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });

      const info = await temporalBridge.promoteProjectBuild(project, run, user?.id);
      res.status(202).json({ message: 'Promoting build to deployment', workflowId: info.id, deploymentId: info.resourceId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
