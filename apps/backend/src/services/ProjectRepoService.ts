/**
 * Registers repositories under the Gitea account belonging to a platform user, and mints the
 * short-lived credential a sandbox pushes with.
 *
 * ── THE CREDENTIAL SPLIT ──
 * Two very different powers, deliberately held in different places:
 *
 *   backend (admin basic auth)  — create the account, create the repo. Never reachable from a pod.
 *   sandbox (write:repository)  — push to repos this user already owns. Nothing else.
 *
 * Verified against Gitea 1.27: the sandbox token cannot create a repository (`write:user` required),
 * cannot enumerate its own account (`read:user` required), and gets "Repository not found" for a
 * different user's repo. Combined with an egress policy that admits only the Gitea namespace, a
 * token stolen by injected code has both a narrow reach and nowhere to be sent.
 */
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

  /** The account name, for callers that need only that — the password never leaves this service. */
  async ensureAccountFor(ownerId: string): Promise<{ username: string }> {
    return { username: (await this.ensureAccount(ownerId)).username };
  }

  /**
   * The user's Gitea account, created on first use. Idempotent.
   */
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
      // Encrypted with the same master key as cloud credentials. It never leaves this process:
      // it exists only to mint push tokens, since Gitea has no admin override for that endpoint.
      passwordEnc: encryptValue(password, this.masterKey),
      createdAt: new Date().toISOString(),
    };
    await this.db.saveGiteaAccount(account);
    return { username, password };
  }

  /**
   * Registers a new project for a user: their Gitea account, a repository owned by it, and the
   * ProjectMetadata record that ties the two to `ownerId`.
   */
  async register(
    ownerId: string,
    name: string,
    opts: { description?: string; language?: string } = {},
  ): Promise<ProjectMetadata> {
    const repoName = sanitiseRepoName(name);

    const mine = (await this.db.getProjects()).filter((p) => p.ownerId === ownerId);
    // A model can call the tool that reaches this in a loop, so the ceiling is enforced here rather
    // than only in the UI.
    if (mine.length >= MAX_PROJECTS_PER_USER) {
      throw new Error(`You already have ${mine.length} projects (limit ${MAX_PROJECTS_PER_USER}).`);
    }
    const clash = mine.find((p) => p.giteaRepo === repoName);
    if (clash) throw new Error(`A project called "${repoName}" already exists.`);

    const { username } = await this.ensureAccount(ownerId);
    // Created with ADMIN rights, deliberately. The sandbox's own token cannot do this, which is
    // what stops a model from creating repositories in a loop.
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
      // What the CODE needs, recorded once here rather than on every persona that works in it.
      ...(opts.language ? { language: opts.language } : {}),
      appType: 'generic',
      createdAt: new Date().toISOString(),
    };
    await this.db.saveProject(project);
    return project;
  }

  /** Every project this user owns. Never returns another user's, even to an admin caller. */
  /**
   * Wires a project so a push can become a running deployment: a Gitea webhook and a target
   * cluster. Idempotent — an already-wired project is left alone.
   *
   * Here rather than in leaf-project.ts because that module deliberately knows nothing about Gitea
   * or clusters, and here rather than only in the HTTP route because the route is not the path the
   * agent's own projects take. See lib/project-shipping.ts.
   *
   * Best-effort by contract: it returns what it could not do rather than throwing. A leaf that
   * produced working code must not be failed because a webhook could not be registered.
   */
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
      /**
       * A target cluster and auto-deploy, so a push completes the whole chain: build, image,
       * running deployment.
       *
       * This IS an escalation and is worth naming. Agent-authored code becomes a running container
       * without anyone pressing a button — the deployed app is not in a leaf's sandbox and does not
       * inherit its NetworkPolicy. It goes to the management cluster because that is the one that
       * always exists, and the alternative was a project that builds an image nothing ever runs,
       * which is what every agent project did until now.
       *
       * Both fields stay editable per project, so turning this off is one field.
       */
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

  /**
   * The clone URL a SANDBOX should use, with a fresh push token embedded.
   *
   * Returned as a whole URL so the caller can clone with it and then move the credential out of
   * the remote — see ExecuteLeafActivity. This does NOT keep the token secret from the agent,
   * which can read any file in its own sandbox; nothing can, because pushing from inside the
   * sandbox requires the credential to be inside the sandbox. What bounds the risk is the token's
   * scope, the egress policy, and revocation at teardown.
   */
  async checkoutCredential(
    ownerId: string,
    project: ProjectMetadata,
  ): Promise<{ cloneUrl: string; tokenName: string; username: string }> {
    if (project.ownerId !== ownerId) {
      // Belt and braces: callers filter by owner already, but this is the function that hands out
      // a write credential, so it re-checks rather than trusting its caller.
      throw new Error('That project belongs to someone else.');
    }

    const { username, password } = await this.ensureAccount(ownerId);
    const { name: tokenName, token } = await this.gitea.createPushToken(username, password);

    const base = this.gitea.internalBaseUrl.replace('http://', `http://${encodeURIComponent(username)}:${token}@`);
    return { cloneUrl: `${base}/${project.giteaOwner}/${project.giteaRepo}.git`, tokenName, username };
  }

  /** Revokes a token minted by checkoutCredential. Called on teardown, success or failure. */
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
