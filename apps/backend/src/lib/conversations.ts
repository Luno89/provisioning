/**
 * General chat with Koala — deliberately NOT a branch.
 *
 * ── WHY A SECOND SHAPE ──
 * A branch is a conversation about building one thing: it belongs to a tree, it accumulates leaves,
 * and everything it produces is work someone accepts and runs. That is the right shape for building
 * and the wrong one for talking. Asking "what is going on with the MCP server" should not require
 * choosing a tree first, and should not leave a branch behind.
 *
 * So general chat gets a normal chat architecture — named threads you return to — and its output is
 * a PROPOSED TREE rather than a leaf. Koala works out what the project is; the Grove is still where
 * it gets built.
 *
 * ── WHAT IS SESSION-SCOPED, AND WHY IT IS STORED ANYWAY ──
 * `enabledMcp` is the servers Koala has hooked up, and it resets per session rather than persisting
 * forever: a tool enabled three weeks ago in a conversation about something else should not still be
 * riding on every message.
 *
 * It is stored against a `sessionId` rather than held in memory, which sounds like a contradiction
 * and is not. The backend runs under `tsx watch` and restarts on every file save, so in-memory state
 * dies several times an hour during development — the user would enable a server, keep typing, and
 * silently lose it. Storing it against a session the CLIENT names gives the reset the session
 * boundary is for, without tying it to the server's uptime.
 */

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Kept separately so a reasoning model's thinking can be shown collapsed, or hidden entirely. */
  reasoning?: string;
  at: string;
  /**
   * Servers hooked up while producing this message.
   *
   * Recorded on the message rather than only announced in prose: the model saying "I've enabled
   * github-mcp" is a claim, and this is the record. The UI renders it as an inline line, so a tool
   * appearing mid-conversation is visible whether or not the model mentions it.
   */
  enabled?: string[];
}

/** A tree Koala thinks should exist. Nothing is created until a human accepts it. */
export interface ProposedTree {
  id: string;
  name: string;
  type: string;
  goal: string;
  proposedAt: string;
  /** Set when accepted, so the card can link to what it became rather than offering twice. */
  treeId?: string;
}

/** An app type Koala thinks should exist. Nothing is deployable until a human accepts it. */
export interface ProposedSpec {
  id: string;
  /** The spec itself, already validated when it was proposed. */
  spec: unknown;
  proposedAt: string;
  /**
   * Replacing a spec that already exists, rather than adding one.
   *
   * Observed live: Koala found its own MongoDB spec crash-looping, worked out it should be
   * corrected, and could not — `propose_spec` refused the id as "already deployable". It called
   * that a catch-22 and it was right. Refusing an edit is only reasonable if editing is possible
   * somewhere, and it was not.
   */
  replaces?: boolean;
  /** Set when accepted, so the card links to what it became rather than offering twice. */
  acceptedAt?: string;
}

export interface Conversation {
  id: string;
  ownerId: string;
  /** First line of the opening message until Koala names it. Never blank in the list. */
  title: string;
  messages: ConversationMessage[];
  /**
   * The client's session, regenerated per page load. `enabledMcp` belongs to this one and is
   * dropped when it changes — see the header for why this is not just held in memory.
   */
  sessionId?: string;
  enabledMcp?: string[];
  proposedTrees?: ProposedTree[];
  proposedSpecs?: ProposedSpec[];
  createdAt: string;
  updatedAt: string;
}

/** Longest title kept; the rest is a tooltip's problem, not the database's. */
const MAX_TITLE = 120;

/**
 * A title from the first thing the user said.
 *
 * Better than "New conversation" for every row, and better than asking a model to name it: that is
 * a second inference call before the user has read the first reply.
 */
export function titleFrom(message: string): string {
  const flat = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

/**
 * The servers enabled for this session, dropping anything from a previous one.
 *
 * Returns a NEW list rather than mutating: the caller writes the whole conversation back, and a
 * mutated array would have already changed the record it is comparing against.
 */
export function enabledForSession(
  conversation: Pick<Conversation, 'sessionId' | 'enabledMcp'>,
  sessionId: string | undefined,
): string[] {
  if (!sessionId || conversation.sessionId !== sessionId) return [];
  return [...(conversation.enabledMcp ?? [])];
}

/** Adds a server to the session's list, starting a new session's list when it changed. */
export function withEnabled(
  conversation: Conversation,
  sessionId: string | undefined,
  server: string,
): Conversation {
  const current = enabledForSession(conversation, sessionId);
  if (current.includes(server)) return conversation;
  return {
    ...conversation,
    ...(sessionId ? { sessionId } : {}),
    enabledMcp: [...current, server],
    updatedAt: new Date().toISOString(),
  };
}
