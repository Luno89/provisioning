import { useState } from 'react';
import { ChevronDown, ChevronRight, Target, CircleDot, Archive } from 'lucide-react';
import AcceptancePlan from './AcceptancePlan.js';
import Delivery, { type DeliveryStage } from './Delivery.js';
import ChatMessageRow from './Chat/ChatMessageRow.js';
import type { ChatMessageRecord } from './Chat/chat-stream.js';

export interface BranchRecord {
  id: string;
  title: string;
  messages: ChatMessageRecord[];
  updatedAt: string;
  treeId?: string;
  projectId?: string;
  acceptance?: { name: string; command: string }[] | string;
  delivery?: DeliveryStage[];
  projectName?: string;
}

export default function BranchHistory({ record }: { record: BranchRecord }) {
  const stages = record.delivery ?? [];
  const landed = stages.length > 0
    && stages.every((s) => s.state === 'done' || s.state === 'skipped')
    && stages.some((s) => s.state === 'done');
  const [open, setOpen] = useState(false);
  const hasHeader = Boolean(record.acceptance) || stages.length > 0;
  const done = stages.filter((s) => s.state === 'done').length;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-start gap-2 px-3 py-2 mb-2 rounded-lg bg-[var(--bark-800)]/60 border border-[var(--bark-700)] text-[12px] text-slate-400">
        <Archive size={13} className="shrink-0 mt-0.5 text-slate-500" />
        <span>History from the old pipeline, kept read-only. New work starts from a conversation on the tree's page.</span>
      </div>

      {hasHeader && (
        <div className="shrink-0 border-b border-[var(--bark-700)] mb-2">
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-1 py-1.5 text-[11px] text-slate-500 hover:text-slate-300"
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {record.acceptance ? <Target size={12} /> : <CircleDot size={12} />}
            <span className="font-black uppercase tracking-widest">
              {stages.length > 0 ? `${done} of ${stages.length} stages` : 'Acceptance'}
            </span>
            {!open && landed && <span className="text-[var(--leaf)] normal-case tracking-normal font-normal">delivered</span>}
            {!open && !landed && stages.length > 0 && (
              <span className="normal-case tracking-normal font-normal">
                {stages.find((s) => s.state !== 'done')?.label ?? 'in progress'}
              </span>
            )}
          </button>

          {open && (
            <div className="pb-2">
              <AcceptancePlan acceptance={record.acceptance} />
              <Delivery
                stages={record.delivery}
                {...(record.projectName ? { projectName: record.projectName } : {})}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto" data-testid="branch-history">
        {record.messages.length === 0 && (
          <p className="px-1 py-2 text-[12px] text-slate-500">Nothing was said here.</p>
        )}
        {record.messages.map((message, index) => (
          <ChatMessageRow key={index} message={message} packLabel="Assistant" />
        ))}
      </div>
    </div>
  );
}
