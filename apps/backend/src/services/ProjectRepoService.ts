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
