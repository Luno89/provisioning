import crypto from 'crypto';
import type { Database } from '../lib/db-interface.js';
import type { GiteaService } from './GiteaService.js';
import type { ProjectMetadata } from '../lib/types.js';
import { webhookUrlFor, DEFAULT_TARGET_CLUSTER } from '../lib/project-shipping.js';
import { encryptValue, decryptValue } from '../lib/crypto.js';
import {
  giteaUsernameFor,
  sanitiseRepoName,
  MAX_PROJECTS_PER_USER,
  type GiteaAccount,
} from '../lib/projects.js';

export class ProjectRepoService {
  constructor(
    private db: Database,
    private gitea: GiteaService,
    private masterKey: string,
  ) {}

  async ensureAccountFor(ownerId: string): Promise<{ username: string }> {
    return { username: (await this.ensureAccount(ownerId)).username };
  }

  private async ensureAccount(ownerId: string): Promise<{ username: string; password: string }> {
    const existing = await this.db.getGiteaAccount(ownerId);
    if (existing) {
      return { username: existing.username, password: decryptValue(existing.passwordEnc, this.masterKey) };
    }

    const username = giteaUsernameFor(ownerId);
    const { password } = await this.gitea.createUserAccount(username, `${username}@koala.local`);

    const account: GiteaAccount = {
      ownerId,
      username,
      passwordEnc: encryptValue(password, this.masterKey),
      createdAt: new Date().toISOString(),
    };
    await this.db.saveGiteaAccount(account);
    return { username, password };
  }

  async register(
    ownerId: string,
    name: string,
    opts: { description?: string; language?: string } = {},
  ): Promise<ProjectMetadata> {
    const repoName = sanitiseRepoName(name);

    const mine = (await this.db.getProjects()).filter((p) => p.ownerId === ownerId);
    if (mine.length >= MAX_PROJECTS_PER_USER) {
      throw new Error(`You already have ${mine.length} projects (limit ${MAX_PROJECTS_PER_USER}).`);
    }
    const clash = mine.find((p) => p.giteaRepo === repoName);
    if (clash) throw new Error(`A project called "${repoName}" already exists.`);

    const { username } = await this.ensureAccount(ownerId);
    await this.gitea.createRepoForUser(username, repoName, {
      private: true,
      ...(opts.description ? { description: opts.description } : {}),
    });

    const project: ProjectMetadata = {
      id: crypto.randomUUID(),
      name: name.trim() || repoName,
      ownerId,
      giteaOwner: username,
      giteaRepo: repoName,
      ...(opts.language ? { language: opts.language } : {}),
      appType: 'generic',
      createdAt: new Date().toISOString(),
    };
    await this.db.saveProject(project);
    return project;
  }

  async ensureShippable(
    project: ProjectMetadata,
    nodeIp: string,
    port: string | number,
    secretKey: string,
  ): Promise<{ project: ProjectMetadata; problems: string[] }> {
    const problems: string[] = [];
    let next = project;

    if (!next.webhookSecretEnc) {
      const secret = crypto.randomBytes(24).toString('hex');
      try {
        await this.gitea.createWebhook(
          next.giteaOwner,
          next.giteaRepo,
          webhookUrlFor(nodeIp, port, next.id),
          secret,
        );
        next = await this.db.saveProjectInfo({ ...next, webhookSecretEnc: encryptValue(secret, secretKey) });
      } catch (err) {
        problems.push(`webhook: ${(err as Error).message}`);
      }
    }

    if (!next.targetClusterId) {
      next = await this.db.saveProjectInfo({
        ...next,
        targetClusterId: DEFAULT_TARGET_CLUSTER,
        autoDeployOnBuild: true,
      });
    }

    return { project: next, problems };
  }

  async listForOwner(ownerId: string): Promise<ProjectMetadata[]> {
    return (await this.db.getProjects()).filter((p) => p.ownerId === ownerId);
  }

  async checkoutCredential(
    ownerId: string,
    project: ProjectMetadata,
  ): Promise<{ cloneUrl: string; tokenName: string; username: string }> {
    if (project.ownerId !== ownerId) {
      throw new Error('That project belongs to someone else.');
    }

    const { username, password } = await this.ensureAccount(ownerId);
    const { name: tokenName, token } = await this.gitea.createPushToken(username, password);

    const base = this.gitea.internalBaseUrl.replace('http://', `http://${encodeURIComponent(username)}:${token}@`);
    return { cloneUrl: `${base}/${project.giteaOwner}/${project.giteaRepo}.git`, tokenName, username };
  }

  async revokeCheckout(ownerId: string, tokenName: string): Promise<void> {
    const account = await this.db.getGiteaAccount(ownerId);
    if (!account) return;
    await this.gitea.revokeUserToken(
      account.username,
      decryptValue(account.passwordEnc, this.masterKey),
      tokenName,
    );
  }
}
