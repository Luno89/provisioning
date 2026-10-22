import { randomBytes } from 'node:crypto';
import type { Leaf } from '../../projects/lib/leaves.js';
import { dropMessage, type DroppedFile } from '../lib/drops.js';
import { dropBranchName, dropSaid, withDrop, type StoryDrop } from '../lib/story-drops.js';
import type { StoryDropWork } from '../../engine-host/sandboxes/story-drop-work.js';

export interface StoryDropDeps {
  leaves: { list(): Promise<Leaf[]>; save(leaf: Leaf): Promise<void> };
  treeOfLeaf: (leaf: Leaf) => Promise<{ id: string; projectIds?: readonly string[] | undefined } | undefined>;
  account: (ownerId: string) => Promise<{ username: string }>;
  credential: (ownerId: string) => Promise<{ token: string }>;
  commit: (token: string, owner: string, repo: string, files: readonly { path: string; bytes: Buffer }[], message: string, branch: string, newBranch: string) => Promise<{ commit: string }>;
  work: StoryDropWork;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

export type StoryDropOutcome = { ok: true; drop: StoryDrop; said: string } | { ok: false; status: 404 | 409; why: string };

export class StoryDropService {
  constructor(private readonly deps: StoryDropDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async drop(ownerId: string, projectId: string, leafId: string, files: readonly DroppedFile[], said?: string | undefined): Promise<StoryDropOutcome> {
    const leaf = (await this.deps.leaves.list()).find((entry) => entry.id === leafId && entry.ownerId === ownerId);
    if (!leaf) return { ok: false, status: 404, why: 'There is no such story.' };
    const tree = await this.deps.treeOfLeaf(leaf);
    if (!tree || !(tree.projectIds ?? []).includes(projectId)) return { ok: false, status: 404, why: 'That story is not part of this project.' };
    const repo = await this.deps.work.repoOf(tree.id);
    if (!repo) return { ok: false, status: 409, why: 'This story\'s tree keeps no repository to drop code into.' };

    const id = this.deps.newId?.() ?? `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const branch = dropBranchName(leafId, id);
    const [{ username }, { token }] = await Promise.all([this.deps.account(ownerId), this.deps.credential(ownerId)]);
    await this.deps.commit(token, username, repo, files, dropMessage(files, said), 'main', branch);

    let arrival;
    try {
      arrival = await this.deps.work.arrive({ ownerId, treeId: tree.id, leafId, branch, message: `Merge what was dropped on the story: ${dropMessage(files, said)}` });
    } catch (err) {
      await this.deps.work.forget({ ownerId, treeId: tree.id, branch }).catch(() => undefined);
      throw err;
    }
    const base: StoryDrop = { id, branch, paths: files.map((file) => file.path), at: this.now(), by: ownerId, state: 'waiting' };
    const drop: StoryDrop = arrival.state === 'merged'
      ? { ...base, state: 'merged', mergedAt: this.now() }
      : arrival.state === 'conflict' ? { ...base, state: 'conflict', conflicts: arrival.conflicts } : base;
    if (drop.state !== 'waiting') await this.deps.work.forget({ ownerId, treeId: tree.id, branch });
    await this.deps.leaves.save({ ...leaf, drops: withDrop(leaf.drops, drop), updatedAt: this.now() } as Leaf);
    return { ok: true, drop, said: dropSaid(drop) };
  }
}
