import { Router, type Request } from 'express';
import crypto from 'crypto';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { encryptValue } from '../lib/crypto.js';
import { localAgentStatus } from '../lib/local-agent-registry.js';
import type { Database } from '../lib/db-interface.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function localAgentsRouter(deps: { db: Database; jwtSecret: string; projects: ProjectRepoService }): Router {
  const { db, jwtSecret, projects } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const mine = (await db.getLocalAgentDevices()).filter((d) => d.ownerId === userOf(req).id);
    res.json(mine.map((d) => ({
      id: d.id,
      name: d.name,
      rootDir: d.rootDir,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      ...localAgentStatus(d.id),
    })));
  });

  router.post('/', async (req, res) => {
    const { name, rootDir } = req.body ?? {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    if (!rootDir || typeof rootDir !== 'string') return res.status(400).json({ error: 'rootDir is required' });

    const id = uuidv4();
    const token = crypto.randomBytes(32).toString('base64url');
    await db.saveLocalAgentDevice({
      id,
      ownerId: userOf(req).id,
      name,
      rootDir,
      tokenEnc: encryptValue(token, jwtSecret),
      createdAt: new Date().toISOString(),
    });

    let projectId: string | undefined;
    try {
      const folderName = path.basename(rootDir) || rootDir;
      const project = await projects.register(userOf(req).id, `${name} - ${folderName}`, {
        withRepo: false,
        executionTarget: { kind: 'local-device', deviceId: id },
      });
      projectId = project.id;
    } catch {}

    res.status(201).json({ id, name, rootDir, token, ...(projectId ? { projectId } : {}) });
  });

  router.delete('/:id', async (req, res) => {
    const devices = await db.getLocalAgentDevices();
    const device = devices.find((d) => d.id === req.params.id && d.ownerId === userOf(req).id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    await db.deleteLocalAgentDevice(device.id);
    res.json({ success: true });
  });

  return router;
}
