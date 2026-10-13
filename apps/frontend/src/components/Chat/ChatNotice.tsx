import { AlertTriangle, Boxes, CheckCircle2, Eye, Hourglass, KeyRound, Leaf, TreeDeciduous } from 'lucide-react';
import type { ConversationNotice, NoticeKind } from '../../api/chat-pack.js';
import { OpenApp } from '../Projects/Workspace/OpenApp.js';
import { formatHash } from '../../lib/route.js';

const LOOK: Record<NoticeKind, { icon: typeof Eye; tone: string }> = {
  'preview-ready': { icon: Eye, tone: 'text-amber-300' },
  'release-live': { icon: CheckCircle2, tone: 'text-emerald-300' },
  'release-failed': { icon: AlertTriangle, tone: 'text-rose-300' },
  'tree-quiet': { icon: TreeDeciduous, tone: 'text-slate-300' },
  'leaf-failed': { icon: Leaf, tone: 'text-rose-300' },
  'secret-needed': { icon: KeyRound, tone: 'text-amber-300' },
  'workspace-ready': { icon: Boxes, tone: 'text-emerald-300' },
  'workspace-waiting': { icon: Hourglass, tone: 'text-amber-300' },
  'workspace-failed': { icon: AlertTriangle, tone: 'text-rose-300' },
};

const timeOf = (at: string | undefined): string => {
  if (!at) return '';
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? '' : when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export interface StoryAddress {
  treeId: string;
  branchId: string;
  leafId: string;
}

export function ChatNotice({ notice, at, onOpenTree, onOpenStory }: {
  notice: ConversationNotice;
  at?: string | undefined;
  onOpenTree?: ((treeId: string) => void) | undefined;
  onOpenStory?: ((story: StoryAddress) => void) | undefined;
}) {
  const { icon: Icon, tone } = LOOK[notice.kind];
  const { projectId, treeId, branchId, leafId } = notice.refs;
  const goes = (action: string) => notice.actions.includes(action as never);
  return (
    <div role="status" className="my-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/60 px-3 py-2 text-[12px]" data-testid="chat-notice">
      <Icon size={14} className={`shrink-0 ${tone}`} aria-hidden="true" />
      <span className="text-slate-200 flex-1 min-w-[12rem]">{notice.text}</span>
      {timeOf(at) && <span className="text-[11px] text-slate-500">{timeOf(at)}</span>}
      <div className="flex flex-wrap items-center gap-2">
        {projectId && goes('open-preview') && <OpenApp projectId={projectId} which="preview" />}
        {projectId && goes('open-app') && <OpenApp projectId={projectId} />}
        {treeId && onOpenTree && (goes('cut-over') || goes('open-tree') || goes('enter-secret')) && (
          <button type="button" onClick={() => onOpenTree(treeId)} className="rounded border border-[var(--bark-600)] px-2 py-0.5 text-[11px] text-slate-200 hover:bg-[var(--bark-700)] cursor-pointer">
            {goes('cut-over') ? 'Cut over or discard…' : goes('enter-secret') ? 'Enter it…' : 'Open the tree'}
          </button>
        )}
        {treeId && goes('open-workspace') && (
          <button type="button" onClick={() => { window.location.hash = formatHash('projects', ['tree', treeId, 'files']) }} className="rounded border border-[var(--bark-600)] px-2 py-0.5 text-[11px] text-slate-200 hover:bg-[var(--bark-700)] cursor-pointer">
            Open the workspace
          </button>
        )}
        {treeId && branchId && leafId && onOpenStory && goes('open-story') && (
          <button type="button" onClick={() => onOpenStory({ treeId, branchId, leafId })} className="rounded border border-[var(--bark-600)] px-2 py-0.5 text-[11px] text-slate-200 hover:bg-[var(--bark-700)] cursor-pointer">
            Open the story
          </button>
        )}
      </div>
    </div>
  );
}

export default ChatNotice;
