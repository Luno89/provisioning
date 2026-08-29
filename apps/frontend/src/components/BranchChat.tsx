import { useState } from 'react';
import AcceptanceEditor from './AcceptanceEditor.js';
import { ChevronDown, ChevronRight, Target, CircleDot } from 'lucide-react';
import Chat, { type Message } from './Chat.js';
import AcceptancePlan from './AcceptancePlan.js';
import Delivery, { type DeliveryStage } from './Delivery.js';
import type { Leaf } from './leaf-types.js';

export interface BranchRecord {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
  treeId?: string;
  acceptance?: { name: string; command: string }[] | string;
  delivery?: DeliveryStage[];
  projectName?: string;
}

export default function BranchChat({
  branchId, record, leaves, messages, onMessagesChange, onProposals,
  onAccept, onReject, onAcceptAll, autoSend, onAutoSent, mode = 'auto', onModeChange, onSetAcceptance,
}: {
  branchId: string;
  record?: BranchRecord | undefined;
  leaves: Leaf[];
  messages: Message[];
  onMessagesChange: (next: Message[] | ((prev: Message[]) => Message[])) => void;
  onProposals: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: (ids: string[]) => void;
  onSetAcceptance?: ((commands: string[]) => Promise<void>) | undefined;
  autoSend?: string | undefined;
  onAutoSent?: (() => void) | undefined;
  mode?: 'chat' | 'auto' | 'plan';
  onModeChange?: ((mode: 'chat' | 'auto' | 'plan') => void) | undefined;
}) {

  const stages = record?.delivery ?? [];
  const landed = stages.length > 0
    && stages.every((s) => s.state === 'done' || s.state === 'skipped')
    && stages.some((s) => s.state === 'done');
  const [open, setOpen] = useState(!landed);

  const planned = Array.isArray(record?.acceptance) ? record.acceptance : [];
  const hasHeader = Boolean(record?.acceptance) || stages.length > 0 || Boolean(onSetAcceptance);
  const done = stages.filter((s) => s.state === 'done').length;

  const proposed = leaves
    .filter((l) => l.branchId === branchId && l.status === 'proposed')
    .map((l) => ({ id: l.id, title: l.title, ...(l.body ? { body: l.body } : {}), ...(l.personaId ? { personaId: l.personaId } : {}) }));

  return (
    <div className="flex flex-col h-full min-h-0">
      {hasHeader && (
        <div className="shrink-0 border-b border-[var(--bark-700)] mb-2">
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-1 py-1.5 text-[11px] text-slate-500 hover:text-slate-300"
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {record?.acceptance ? <Target size={12} /> : <CircleDot size={12} />}
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
              <AcceptancePlan acceptance={record?.acceptance} />
              {onSetAcceptance && <AcceptanceEditor checks={planned} onSave={onSetAcceptance} />}
              <Delivery
                stages={record?.delivery}
                {...(record?.projectName ? { projectName: record.projectName } : {})}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <Chat
          branchId={branchId}
          mode={mode}
          {...(onModeChange ? { onModeChange } : {})}
          onProposals={onProposals}
          {...(autoSend ? { autoSend, ...(onAutoSent ? { onAutoSent } : {}) } : {})}
          messages={messages}
          onMessagesChange={onMessagesChange}
          proposed={proposed}
          onAccept={onAccept}
          onReject={onReject}
          onAcceptAll={() => onAcceptAll(proposed.map((p) => p.id))}
        />
      </div>
    </div>
  );
}
