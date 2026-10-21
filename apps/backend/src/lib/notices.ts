import type { ConversationNotice, NoticeAction, NoticeKind } from './conversations.js';
import { workflowOfRun } from '../engine-host/temporal/contracts.js';
import type { OdooRelease } from './odoo-release.js';
import { changesSentence } from './release-compare.js';
import { importedSentence } from './client-import.js';
import type { Leaf } from './leaves.js';

const short = (commit: string): string => commit.slice(0, 8);

export function releaseNotice(release: Pick<OdooRelease, 'id' | 'projectId' | 'commit' | 'slot' | 'state' | 'reason' | 'e2e' | 'changes' | 'restore'>, treeId: string | undefined, made?: number | undefined): ConversationNotice | undefined {
  const refs = { projectId: release.projectId, releaseId: release.id, ...(treeId ? { treeId } : {}) };
  const slot = release.slot ? ` in slot ${release.slot}` : '';
  if (release.state === 'preview') {
    const tests = release.e2e?.state === 'passed' ? `; its browser tests passed (${release.e2e.summary ?? 'all of them'})`
      : release.e2e?.state === 'failed' ? `; its browser tests did not all pass (${release.e2e.summary ?? 'see the card'})`
      : '';
    return {
      key: `release:${release.id}:preview`,
      kind: 'preview-ready',
      text: `A preview of ${short(release.commit)} is ready${slot}${tests}. ${release.changes ? `${changesSentence(release.changes)} ` : ''}Look it over, then cut over or discard it on the project's card.`,
      refs,
      actions: ['open-preview', 'cut-over'],
    };
  }
  if (release.state === 'live' && release.restore) {
    const things = made === undefined ? 'Settings shows what was made in their app' : made === 0 ? 'nothing in it was made in their app outside git' : `${count(made, 'thing was', 'things were')} made in their app, which Settings lists and can bring into git`;
    return {
      key: `release:${release.id}:live`,
      kind: 'release-live',
      text: `${importedSentence(release.restore)}; ${things}.`,
      refs,
      actions: ['open-app', 'open-settings'],
    };
  }
  if (release.state === 'live') {
    return { key: `release:${release.id}:live`, kind: 'release-live', text: `${short(release.commit)} is live${slot}.`, refs, actions: ['open-app'] };
  }
  if (release.state === 'failed') {
    return {
      key: `release:${release.id}:failed`,
      kind: 'release-failed',
      text: release.restore
        ? `Starting from the client's database failed${release.reason ? `: ${release.reason}` : ''}. Nothing is live yet; Settings says what to do next.`
        : `The release of ${short(release.commit)} failed${release.reason ? `: ${release.reason}` : ''}. What was live keeps running.`,
      refs,
      actions: release.restore ? ['open-settings'] : ['open-tree'],
    };
  }
  return undefined;
}

export function awaitedNotice(project: { id: string; name: string }, commit: string, treeId: string | undefined): ConversationNotice {
  return {
    key: `client-database:${project.id}:awaited`,
    kind: 'client-database-awaited',
    text: `${project.name} is built (${short(commit)}) and waits for the client's database before its first release. Upload their backup on the project's Settings, or start without it there.`,
    refs: { projectId: project.id, ...(treeId ? { treeId } : {}) },
    actions: ['open-settings'],
  };
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function treeNotices(
  tree: { id: string; name: string; projectId?: string | undefined },
  leaves: readonly Pick<Leaf, 'id' | 'branchId' | 'title' | 'status' | 'findings'>[],
  run: { runId: string; outcome: string; reason?: string | undefined },
): ConversationNotice[] {
  const refs = { treeId: tree.id, ...(tree.projectId ? { projectId: tree.projectId } : {}) };
  const landed = leaves.filter((leaf) => leaf.status === 'succeeded').length;
  const failed = leaves.filter((leaf) => leaf.status === 'failed');
  const waiting = leaves.filter((leaf) => leaf.status === 'pending' || leaf.status === 'claimed').length;
  const how = run.outcome === 'ok'
    ? `Work on ${tree.name} finished: ${count(landed, 'story', 'stories')} landed${failed.length ? `, ${failed.length} failed` : ''}${waiting ? `, ${waiting} still to work` : ''}.`
    : `Work on ${tree.name} stopped (${run.outcome}${run.reason ? `: ${run.reason}` : ''}): ${count(landed, 'story', 'stories')} landed${failed.length ? `, ${failed.length} failed` : ''}.`;
  return [
    { key: `tree:${run.runId}:${run.outcome}`, kind: 'tree-quiet', text: how, refs, actions: ['open-tree'] },
    ...failed.map((leaf): ConversationNotice => ({
      key: `leaf:${leaf.id}:failed:${run.runId}`,
      kind: 'leaf-failed',
      text: `The story "${leaf.title}" failed${leaf.findings ? `: ${leaf.findings.slice(0, 300)}` : ''}.`,
      line: `The story "${leaf.title}" failed; what went wrong is in its chat.`,
      refs: { ...refs, branchId: leaf.branchId, leafId: leaf.id },
      actions: ['open-tree'],
    })),
  ];
}

export function secretNotice(request: { id: string; projectId: string; treeId?: string | undefined; key: string; description: string }): ConversationNotice {
  return {
    key: `secret:${request.id}`,
    kind: 'secret-needed',
    text: `The app needs ${request.key}, which only you can enter: ${request.description}`,
    refs: { projectId: request.projectId, requestId: request.id, ...(request.treeId ? { treeId: request.treeId } : {}) },
    actions: ['enter-secret'],
  };
}

export const GROVE_RUN_PREFIX = 'grove-run-';

export function grovedTree(runId: string, depth: number): string | undefined {
  const workflowId = workflowOfRun(runId);
  return depth === 0 && workflowId.startsWith(GROVE_RUN_PREFIX) ? workflowId.slice(GROVE_RUN_PREFIX.length) : undefined;
}

export type WorkspaceNoticeKind = 'ready' | 'waiting' | 'failed' | 'declined';

export function workspaceNotice(
  what: WorkspaceNoticeKind,
  tree: { id: string; name: string; projectId?: string | undefined },
  run: { runId: string; summary?: string | undefined; reason?: string | undefined },
): ConversationNotice {
  const refs = { treeId: tree.id, ...(tree.projectId ? { projectId: tree.projectId } : {}) };
  const text = what === 'ready'
    ? `The workspace for ${tree.name} is ready${run.summary ? `: ${run.summary}` : ''}. Stories waiting for it are back in line.`
    : what === 'waiting'
      ? `The workspace for ${tree.name} waits for you: it would run an install script while the image builds${run.summary ? ` (${run.summary})` : ''}. Approve or decline it in the build.`
      : what === 'declined'
        ? `The workspace for ${tree.name} was not changed: the install script was declined.`
        : `The workspace for ${tree.name} could not be built${run.reason ? `: ${run.reason}` : ''}. It keeps working in the one it had.`;
  return { key: `workspace:${run.runId}:${what}`, kind: what === 'ready' ? 'workspace-ready' : what === 'waiting' ? 'workspace-waiting' : 'workspace-failed', text, refs, actions: ['open-workspace'] };
}

const NOTICE_KINDS: readonly NoticeKind[] = ['preview-ready', 'release-live', 'release-failed', 'tree-quiet', 'leaf-failed', 'secret-needed', 'workspace-ready', 'workspace-waiting', 'workspace-failed'];
const NOTICE_ACTIONS: readonly NoticeAction[] = ['open-preview', 'open-app', 'cut-over', 'open-tree', 'open-story', 'enter-secret', 'open-workspace', 'open-settings'];

export function postedNotice(value: Readonly<Record<string, unknown>>): ConversationNotice | undefined {
  const refs = value.refs as Record<string, unknown> | undefined;
  if (typeof value.key !== 'string' || typeof value.text !== 'string' || !NOTICE_KINDS.includes(value.kind as NoticeKind)) return undefined;
  if (!refs || typeof refs !== 'object') return undefined;
  const text = (name: string) => (typeof refs[name] === 'string' ? { [name]: refs[name] as string } : {});
  const actions = Array.isArray(value.actions) ? value.actions.filter((action): action is NoticeAction => NOTICE_ACTIONS.includes(action as NoticeAction)) : [];
  return {
    key: value.key,
    kind: value.kind as NoticeKind,
    text: value.text,
    refs: { ...text('projectId'), ...text('treeId'), ...text('branchId'), ...text('leafId') },
    ...(typeof value.line === 'string' ? { line: value.line } : {}),
    actions,
  };
}

export function hubConflictNotice(project: { id: string; name: string }, conflict: { files: readonly string[]; kept: string }, treeId: string | undefined): ConversationNotice {
  return {
    key: `hub-main-conflict:${project.id}:${conflict.kept}`,
    kind: 'hub-main-conflict',
    text: `${project.name}'s main and the shared main on the hub changed the same lines (${conflict.files.join(', ') || 'files git could not name'}), so neither was changed. The hub's main is kept as the branch ${conflict.kept}; merge it into main and the two are joined again.`,
    refs: { projectId: project.id, ...(treeId ? { treeId } : {}) },
    actions: ['open-tree'],
  };
}
