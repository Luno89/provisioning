import crypto from 'crypto';
import type { Database } from '../lib/db-interface.js';
import type { GiteaService, RepoFileEntry } from './GiteaService.js';
import type { ProjectMetadata } from '../lib/types.js';
import { webhookUrlFor, DEFAULT_TARGET_CLUSTER } from '../lib/project-shipping.js';
import { encryptValue, decryptValue } from '../lib/crypto.js';
import {
  giteaUsernameFor,
  sanitiseRepoName,
  MAX_PROJECTS_PER_USER,
  type GiteaAccount,
} from '../lib/projects.js';

const EDITOR_TOKEN_TTL_MS = 30 * 60 * 1000;

export class ProjectRepoService {
  private editorTokens = new Map<string, { token: string; username: string; mintedAt: number }>();

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
    opts: {
      description?: string;
      language?: string;
      withRepo?: boolean;
      executionTarget?: ProjectMetadata['executionTarget'];
    } = {},
  ): Promise<ProjectMetadata> {
    const withRepo = opts.withRepo !== false;
    const repoName = sanitiseRepoName(name);

    const mine = (await this.db.getProjects()).filter((p) => p.ownerId === ownerId);
    if (mine.length >= MAX_PROJECTS_PER_USER) {
      throw new Error(`You already have ${mine.length} projects (limit ${MAX_PROJECTS_PER_USER}).`);
    }

    let repoFields: { giteaOwner: string; giteaRepo: string } | Record<string, never> = {};
    if (withRepo) {
      const clash = mine.find((p) => p.giteaRepo === repoName);
      if (clash) throw new Error(`A project called "${repoName}" already exists.`);

      const { username } = await this.ensureAccount(ownerId);
      await this.gitea.createRepoForUser(username, repoName, {
        private: true,
        ...(opts.description ? { description: opts.description } : {}),
      });
      repoFields = { giteaOwner: username, giteaRepo: repoName };
    }

    const project: ProjectMetadata = {
      id: crypto.randomUUID(),
      name: name.trim() || repoName,
      ownerId,
      ...repoFields,
      ...(opts.language ? { language: opts.language } : {}),
      appType: withRepo ? 'generic' : 'local',
      ...(opts.executionTarget ? { executionTarget: opts.executionTarget } : {}),
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

    if (!next.giteaOwner || !next.giteaRepo) {
      return { project: next, problems };
    }

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

  /**
   * Commit a document into the project repository over the Gitea contents API.
   *
   * No checkout and no sandbox: this is the same path `seedTemplate` uses to scaffold a tree
   * type's starter files. A planner needs to leave a document behind, and giving it a container
   * to do that in would also give it a shell it has no business having.
   */
  async writeDocument(
    project: Pick<ProjectMetadata, 'giteaOwner' | 'giteaRepo'>,
    path: string,
    content: string,
    message: string,
  ): Promise<boolean> {
    if (!project.giteaOwner || !project.giteaRepo) {
      throw new Error('This project has no repository to write a document to.');
    }
    return this.gitea.ensureFile(project.giteaOwner, project.giteaRepo, path, content, message);
  }

  async readPath(
    project: Pick<ProjectMetadata, 'ownerId' | 'giteaOwner' | 'giteaRepo'>,
    path: string,
  ): Promise<{ path: string; type: 'file'; content: string } | { path: string; type: 'dir'; entries: RepoFileEntry[] }> {
    if (!project.giteaOwner || !project.giteaRepo) {
      throw new Error('This project has no repository to read from.');
    }
    const MAX_CONTENT_LENGTH = 100_000;
    const { token } = await this.editorCredential(project.ownerId ?? '');
    try {
      const file = await this.gitea.getFileContent(token, project.giteaOwner, project.giteaRepo, path);
      if (file) {
        const content = file.content.length > MAX_CONTENT_LENGTH
          ? `${file.content.slice(0, MAX_CONTENT_LENGTH)}\n…(truncated — file is larger than ${MAX_CONTENT_LENGTH} characters)`
          : file.content;
        return { path, type: 'file', content };
      }
    } catch {}
    const entries = await this.gitea.listDirectory(token, project.giteaOwner, project.giteaRepo, path);
    return { path, type: 'dir', entries };
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

  /** A scoped, read-only Gitea token for the owner's own account — for auto-provisioning GITEA_TOKEN. */
  async mintReadToken(ownerId: string): Promise<{ token: string; tokenName: string; username: string }> {
    const { username, password } = await this.ensureAccount(ownerId);
    const { name: tokenName, token } = await this.gitea.createReadToken(username, password);
    return { token, tokenName, username };
  }

  async editorCredential(ownerId: string): Promise<{ token: string; username: string }> {
    const cached = this.editorTokens.get(ownerId);
    if (cached && Date.now() - cached.mintedAt < EDITOR_TOKEN_TTL_MS) {
      return { token: cached.token, username: cached.username };
    }

    const { username, password } = await this.ensureAccount(ownerId);
    const { token } = await this.gitea.createPushToken(username, password);
    this.editorTokens.set(ownerId, { token, username, mintedAt: Date.now() });
    return { token, username };
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
