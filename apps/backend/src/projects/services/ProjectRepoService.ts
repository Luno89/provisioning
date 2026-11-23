import crypto from 'crypto';
import { type Database, type ProjectMetadata, encryptValue, decryptValue, type SecretKey, allowed, asPerson, reopening, keepTrying, stillDown, type DependencyRefusals, type Reopening } from '../../platform/index.js';
import { leftOver, type GiteaTokenPods, type TokenToRevoke } from '../lib/gitea-tokens.js';
import type { GiteaService, RepoFileEntry } from './GiteaService.js';
import { ignore } from '@koala/engine-core/failures';
import {
  giteaUsernameFor,
  sanitiseRepoName,
  MAX_PROJECTS_PER_USER,
  type GiteaAccount,
} from '../lib/projects.js';

export interface NewProject {
  id?: string | undefined;
  name: string;
  repo: string;
  existing?: boolean | undefined;
  language?: string | undefined;
  targetClusterId?: string | undefined;
  autoDeployOnBuild: boolean;
  description?: string | undefined;
  starter?: { path: string; content: string }[] | undefined;
  extra?: Partial<ProjectMetadata> | undefined;
}

const EDITOR_TOKEN_TTL_MS = 30 * 60 * 1000;

export class ProjectRepoService {
  private editorTokens = new Map<string, { token: string; username: string; mintedAt: number }>();

  constructor(
    private db: Database,
    private gitea: GiteaService,
    private masterKey: SecretKey,
    private webhookUrl: ((projectId: string) => Promise<string>) | undefined,
    private options: { recordWaitMs?: number | undefined; defaultCluster?: string | undefined; again?: (() => Reopening) | undefined; log?: ((message: string) => void) | undefined; process?: string | undefined; refusals: DependencyRefusals },
  ) {}

  async ensureAccountFor(ownerId: string): Promise<{ username: string }> {
    return { username: (await this.ensureAccount(ownerId)).username };
  }

  private readonly creating = new Map<string, Promise<{ username: string; password: string }>>();

  private async ensureAccount(ownerId: string): Promise<{ username: string; password: string }> {
    const existing = await this.db.projects.getGiteaAccount(ownerId);
    if (existing) {
      return { username: existing.username, password: decryptValue(existing.passwordEnc, this.masterKey) };
    }
    const under = this.creating.get(ownerId);
    if (under) return under;
    const made = this.createAccount(ownerId).finally(() => this.creating.delete(ownerId));
    this.creating.set(ownerId, made);
    return made;
  }

  private async createAccount(ownerId: string): Promise<{ username: string; password: string }> {
    const username = giteaUsernameFor(ownerId);
    let password: string;
    try {
      ({ password } = await this.gitea.createUserAccount(username, `${username}@koala.local`));
    } catch (err) {
      const said = (err as Error).message;
      if (!/HTTP \d{3}/.test(said) && !/duplicate key|already exists|user already/i.test(said)) {
        if (await this.gitea.userExists(username)) return this.takeOver(ownerId, username);
        throw err;
      }
      if (!/duplicate key|already exists|user already/i.test(said)) throw err;
      const waitMs = this.options.recordWaitMs ?? 30_000;
      const step = Math.min(1_000, waitMs);
      for (let waited = 0; waited < waitMs; waited += step) {
        const saved = await this.db.projects.getGiteaAccount(ownerId);
        if (saved) return { username: saved.username, password: decryptValue(saved.passwordEnc, this.masterKey) };
        await new Promise((resolve) => setTimeout(resolve, step));
      }
      return this.takeOver(ownerId, username);
    }

    const account: GiteaAccount = {
      ownerId,
      username,
      passwordEnc: encryptValue(password, this.masterKey),
      createdAt: new Date().toISOString(),
    };
    await this.db.projects.saveGiteaAccount(account);
    return { username, password };
  }

  private async takeOver(ownerId: string, username: string): Promise<{ username: string; password: string }> {
    const stored = await this.db.projects.claimGiteaAccount({
      ownerId,
      username,
      passwordEnc: encryptValue(crypto.randomBytes(24).toString('base64url'), this.masterKey),
      createdAt: new Date().toISOString(),
    });
    const password = decryptValue(stored.passwordEnc, this.masterKey);
    await this.gitea.setUserPassword(stored.username, password);
    return { username: stored.username, password };
  }

  async register(
    ownerId: string,
    name: string,
    opts: { language?: string; executionTarget?: ProjectMetadata['executionTarget'] } = {},
  ): Promise<ProjectMetadata> {
    await this.underLimit(ownerId);
    const project: ProjectMetadata = {
      id: crypto.randomUUID(),
      name: name.trim() || 'project',
      ownerId,
      ...(opts.language ? { language: opts.language } : {}),
      appType: 'local',
      ...(opts.executionTarget ? { executionTarget: opts.executionTarget } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.db.projects.saveProject(project);
    return project;
  }

  async removeFor(ownerId: string, deviceId: string): Promise<void> {
    const made = (await this.db.projects.getProjects()).filter((project) => project.ownerId === ownerId && project.appType === 'local' && project.executionTarget?.kind === 'local-device' && project.executionTarget.deviceId === deviceId);
    if (!made.length) return;
    const ids = new Set(made.map((project) => project.id));
    for (const tree of await this.db.projects.getTrees()) {
      if (!tree.projectIds?.some((id) => ids.has(id))) continue;
      await this.db.projects.saveTree({ ...tree, projectIds: tree.projectIds.filter((id) => !ids.has(id)), updatedAt: new Date().toISOString() });
    }
    for (const project of made) await this.db.projects.removeProjectRecords(project.id);
  }

  private async underLimit(ownerId: string): Promise<void> {
    const mine = (await this.db.projects.getProjects()).filter((p) => p.ownerId === ownerId);
    if (mine.length >= MAX_PROJECTS_PER_USER) {
      throw new Error(`You already have ${mine.length} projects (limit ${MAX_PROJECTS_PER_USER}).`);
    }
  }

  async createProject(ownerId: string, input: NewProject): Promise<ProjectMetadata> {
    if (!this.webhookUrl) throw new Error('projects cannot be made here: nothing says where their pushes are sent');
    const id = input.id ?? crypto.randomUUID();
    const repo = sanitiseRepoName(input.repo);
    const existing = (await this.db.projects.getProjects()).find((p) => p.id === id);
    if (existing && !allowed(asPerson(ownerId), 'change', { kind: 'project', ownerId: existing.ownerId })) throw new Error(`project ${id} belongs to someone else`);
    if (existing?.webhookSecretEnc && (!input.starter?.length)) return existing;

    const creating = !input.existing;
    let project = existing;
    if (!project) {
      await this.underLimit(ownerId);
      const mine = (await this.db.projects.getProjects()).filter((p) => p.ownerId === ownerId);
      if (mine.some((p) => p.giteaRepo === repo)) throw new Error(`You already have a project whose repository is called "${repo}".`);
      const giteaOwner = (await this.ensureAccount(ownerId)).username;
      if (!creating && !(await this.gitea.findRepo(giteaOwner, repo))) throw new Error(`You have no repository called "${repo}" to use; make it here instead.`);
      const target = input.targetClusterId ?? this.options.defaultCluster;
      project = await this.db.projects.saveProjectInfo({
        id,
        name: input.name.trim() || repo,
        ownerId,
        giteaOwner,
        giteaRepo: repo,
        ...(input.language ? { language: input.language } : {}),
        appType: 'gitapp',
        ...(target ? { targetClusterId: target } : {}),
        autoDeployOnBuild: input.autoDeployOnBuild,
        ...input.extra,
        createdAt: new Date().toISOString(),
      } as ProjectMetadata);
    }
    const owner = project.giteaOwner!;

    if (creating) {
      const there = Boolean(await this.gitea.findRepo(owner, repo));
      if (!there) await this.gitea.createRepoForUser(owner, repo, { private: true, ...(input.description ? { description: input.description } : {}) });
    }

    if (!project.webhookSecretEnc) {
      const secret = crypto.randomBytes(32).toString('hex');
      await this.gitea.replaceWebhook(owner, repo, await this.webhookUrl(id), secret);
      project = await this.db.projects.saveProjectInfo({ ...project, webhookSecretEnc: encryptValue(secret, this.masterKey) });
    }

    if (input.starter?.length) await this.gitea.seedTemplate(owner, repo, input.starter);
    return project;
  }

  async rehook(projectId: string): Promise<void> {
    const project = (await this.db.projects.getProjects()).find((entry) => entry.id === projectId);
    if (!project?.giteaOwner || !project.giteaRepo) return;
    if (!this.webhookUrl) throw new Error('a restored project\'s webhook cannot be made here: nothing says where its pushes are sent');
    const secret = crypto.randomBytes(32).toString('hex');
    await this.gitea.replaceWebhook(project.giteaOwner, project.giteaRepo, await this.webhookUrl(project.id), secret);
    await this.db.projects.saveProjectInfo({ ...project, webhookSecretEnc: encryptValue(secret, this.masterKey) });
  }

  async unhook(projectId: string): Promise<number> {
    const project = (await this.db.projects.getProjects()).find((entry) => entry.id === projectId);
    if (!project?.giteaOwner || !project.giteaRepo) return 0;
    if (!this.webhookUrl) throw new Error('a deleted project\'s webhook cannot be removed here: nothing says where its pushes are sent');
    return this.gitea.removeWebhook(project.giteaOwner, project.giteaRepo, await this.webhookUrl(project.id));
  }

  async repointWebhooks(): Promise<{ repointed: number }> {
    if (!this.webhookUrl) return { repointed: 0 };
    let repointed = 0;
    for (const project of await this.db.projects.getProjects()) {
      if (project.removal || !project.giteaOwner || !project.giteaRepo || !project.webhookSecretEnc) continue;
      await this.gitea.replaceWebhook(project.giteaOwner, project.giteaRepo, await this.webhookUrl(project.id), decryptValue(project.webhookSecretEnc, this.masterKey));
      repointed += 1;
    }
    return { repointed };
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

  async putDocument(ownerId: string, repo: string, path: string, content: string, message: string, branch: string): Promise<{ changed: boolean; commit?: string | undefined }> {
    const { username } = await this.ensureAccount(ownerId);
    if (!(await this.gitea.findRepo(username, repo))) throw new Error(`There is no repository "${repo}" to write ${path} to.`);
    return this.gitea.putFile(username, repo, path, content, message, branch);
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
    } catch (failure) {
      ignore('a directory is not a file, and is listed below, where any other failure is met again')(failure);
    }
    const entries = await this.gitea.listDirectory(token, project.giteaOwner, project.giteaRepo, path);
    return { path, type: 'dir', entries };
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

  async pushDocuments(request: { ownerId: string; repo: string; describe: string; bundle: string }): Promise<{ owner: string; repo: string; commit: string }> {
    const { username, password } = await this.ensureAccount(request.ownerId);
    const created = !(await this.gitea.findRepo(username, request.repo));
    if (created) {
      await this.gitea.createRepoForUser(username, request.repo, { private: true, description: request.describe, empty: true });
    }
    return this.withToken(request.ownerId, username, password, () => this.gitea.createPushToken(username, password), async (token) => {
      const commit = await this.gitea.pushBundle({ username, token }, username, request.repo, request.bundle);
      if (created) await this.untilServed(username, request.repo);
      return { owner: username, repo: request.repo, commit };
    });
  }

  private async untilServed(owner: string, repo: string): Promise<void> {
    const again = reopening(250);
    while (!(await this.gitea.repoServesFiles(owner, repo))) await again.after();
  }

  async mergeDocuments(request: { ownerId: string; repo: string; head: string; base: string; title: string; body: string }): Promise<'merged' | 'conflict' | 'nothing' | 'failed'> {
    const { username } = await this.ensureAccount(request.ownerId);
    return this.gitea.mergeBranch(username, request.repo, request.head, request.base, { title: request.title, body: request.body });
  }

  async pullDocuments(request: { ownerId: string; repo: string; bundle: string }): Promise<boolean> {
    const { username, password } = await this.ensureAccount(request.ownerId);
    if (!(await this.gitea.findRepo(username, request.repo))) return false;
    return this.withToken(request.ownerId, username, password, () => this.gitea.createReadToken(username, password),
      (token) => this.gitea.pullBundle({ username, token }, username, request.repo, request.bundle));
  }

  async diffCommits(request: { ownerId: string; owner: string; repo: string; base: string; head: string }): Promise<string> {
    const { username, password } = await this.ensureAccount(request.ownerId);
    return this.withToken(request.ownerId, username, password, () => this.gitea.createReadToken(username, password),
      (token) => this.gitea.diffBetween({ username, token }, request.owner, request.repo, request.base, request.head));
  }

  async pushBranch(request: { ownerId: string; repo: string; describe: string; bundle: string; branch: string }): Promise<string> {
    const { username, password } = await this.ensureAccount(request.ownerId);
    const created = !(await this.gitea.findRepo(username, request.repo));
    if (created) {
      await this.gitea.createRepoForUser(username, request.repo, { private: true, description: request.describe, empty: true });
    }
    return this.withToken(request.ownerId, username, password, () => this.gitea.createPushToken(username, password), async (token) => {
      const commit = await this.gitea.pushBranchBundle({ username, token }, username, request.repo, request.bundle, request.branch, { asMain: created });
      if (created) await this.untilServed(username, request.repo);
      return commit;
    });
  }

  async pullBranch(request: { ownerId: string; repo: string; branch: string; bundle: string }): Promise<boolean> {
    const { username, password } = await this.ensureAccount(request.ownerId);
    if (!(await this.gitea.findRepo(username, request.repo))) return false;
    return this.withToken(request.ownerId, username, password, () => this.gitea.createReadToken(username, password),
      (token) => this.gitea.pullBranchBundle({ username, token }, username, request.repo, request.branch, request.bundle));
  }

  async deleteBranch(request: { ownerId: string; repo: string; branch: string }): Promise<void> {
    const { username } = await this.ensureAccount(request.ownerId);
    await this.gitea.deleteBranch(username, request.repo, request.branch);
  }

  async gitRemote(ownerId: string, repo: string): Promise<{ url: string; authorization: string } | undefined> {
    const { username, password } = await this.ensureAccount(ownerId);
    if (!(await this.gitea.findRepo(username, repo))) return undefined;
    return {
      url: await this.gitea.repoGitUrl(username, repo),
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    };
  }

  async readDocument(ownerId: string, repo: string, path: string, ref: string): Promise<{ owner: string; repo: string; content: string } | null> {
    const { username } = await this.ensureAccount(ownerId);
    if (!(await this.gitea.findRepo(username, repo))) return null;
    const content = await this.gitea.getRawFile(username, repo, path.split('/').map(encodeURIComponent).join('/'), ref);
    return content === null ? null : { owner: username, repo, content };
  }

  private async withToken<T>(ownerId: string, username: string, password: string, mint: () => Promise<{ name: string; token: string }>, use: (token: string) => Promise<T>): Promise<T> {
    const { name, token } = await mint();
    const kept: TokenToRevoke = { name, ownerId, username, process: this.options.process, at: new Date().toISOString() };
    try {
      await this.db.projects.saveTokenToRevoke(kept);
    } catch (err) {
      await this.revoke(kept, password);
      throw err;
    }
    try {
      return await use(token);
    } finally {
      await this.revoke(kept, password);
    }
  }

  private async revokeNow(kept: TokenToRevoke, password: string): Promise<void> {
    await this.gitea.revokeUserToken(kept.username, password, kept.name);
    await this.db.projects.dropTokenToRevoke(kept);
  }

  private async revoke(kept: TokenToRevoke, password: string): Promise<void> {
    await keepTrying(`[ProjectRepoService] the Gitea token ${kept.name} of ${kept.username} is still valid, since revoking it failed`,
      () => this.revokeNow(kept, password), this.log(), (reason) => this.refused(`revoking the token ${kept.name} of ${kept.username}: ${reason}`), this.options.again?.() ?? reopening());
  }

  private log(): (message: string) => void {
    return this.options.log ?? ((message: string) => console.warn(message));
  }

  private refused(reason: string): void {
    this.options.refusals.refused('gitea', reason);
  }

  keepRevokingLeftovers(pods: GiteaTokenPods): Promise<boolean> {
    return keepTrying('[ProjectRepoService] the Gitea tokens a gone pod left are not revoked yet',
      async () => {
        const watch = await pods.whenGone((pod) => { void this.revokeTokensOf(pod); });
        await this.revokeLeftoverTokens(await pods.live());
        const ended = await watch.ended;
        throw stillDown(`the watch on Koala's pods ended: ${ended.stderr.trim() || `exit ${ended.code}`}`);
      },
      this.log(), (reason) => this.refused(`revoking the Gitea tokens gone pods left: ${reason}`), this.options.again?.());
  }

  async revokeLeftoverTokens(live: readonly string[]): Promise<number> {
    const left = leftOver(await this.db.projects.getTokensToRevoke(), live);
    await this.revokeEach(left);
    return left.length;
  }

  private async revokeTokensOf(pod: string): Promise<void> {
    await this.revokeEach((await this.db.projects.getTokensToRevoke()).filter((kept) => kept.process === pod));
  }

  private async revokeEach(left: readonly TokenToRevoke[]): Promise<void> {
    for (const kept of left) {
      const account = await this.db.projects.getGiteaAccount(kept.ownerId);
      if (account) await this.gitea.revokeUserToken(kept.username, decryptValue(account.passwordEnc, this.masterKey), kept.name);
      await this.db.projects.dropTokenToRevoke(kept);
    }
  }

  async revokeCheckout(ownerId: string, tokenName: string): Promise<void> {
    const account = await this.db.projects.getGiteaAccount(ownerId);
    if (!account) return;
    await this.gitea.revokeUserToken(
      account.username,
      decryptValue(account.passwordEnc, this.masterKey),
      tokenName,
    );
  }
}
