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

/**
 * One conversation: what it promised, what became of it, and the transcript.
 *
 * ── WHY THE HEADER COLLAPSES ──
 * These three blocks — the acceptance plan, the delivery stages and the composer's own toolbar —
 * used to stack above the transcript unconditionally. Measured on a 1000px viewport, the
 * conversation got about 55% of the pane and was clipped mid-sentence at the top, which is the one
 * thing in this view nobody can afford to lose.
 *
 * So they fold into a single strip that says the state in one line and opens on demand. It starts
 * OPEN while work is in flight, because that is when the stages are the thing you came to read, and
 * closed once the request has landed, when they are a record rather than news.
 *
 * ── AND WHY IT IS ITS OWN COMPONENT ──
 * Two navigators now open a conversation. Assembling it twice is how they would start to differ.
 */
export default function BranchChat({
  apiBase, branchId, record, leaves, messages, onMessagesChange, onProposals,
  onAccept, onReject, onAcceptAll, autoSend, onAutoSent, mode = 'auto', onModeChange, onSetAcceptance,
}: {
  apiBase: string;
  branchId: string;
  record?: BranchRecord | undefined;
  /** Every leaf, so this can find the ones awaiting a decision on this branch. */
  leaves: Leaf[];
  messages: Message[];
  onMessagesChange: (next: Message[] | ((prev: Message[]) => Message[])) => void;
  onProposals: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: (ids: string[]) => void;
  /**
   * Saves an acceptance plan for this branch, one command per entry.
   *
   * Optional so every existing caller keeps working. Absent hides the editor rather than showing a
   * control that does nothing.
   */
  onSetAcceptance?: ((commands: string[]) => Promise<void>) | undefined;
  autoSend?: string | undefined;
  onAutoSent?: (() => void) | undefined;
  /**
   * Which mode this conversation is in, held by the CALLER.
   *
   * It lived here at first, and this component unmounts every time a leaf is selected — so typing
   * `/chat`, clicking a leaf to look at something, and coming back silently put you in `auto`
   * again, where the next message would start extracting work. The one place mode must not live is
   * the thing that unmounts while you are using it.
   */
  mode?: 'chat' | 'auto' | 'plan';
  onModeChange?: ((mode: 'chat' | 'auto' | 'plan') => void) | undefined;
}) {

  const stages = record?.delivery ?? [];
  // `skipped` counts as settled — a research request never builds an image, and waiting for a stage
  // that will never run would hold the strip open forever.
  const landed = stages.length > 0
    && stages.every((s) => s.state === 'done' || s.state === 'skipped')
    && stages.some((s) => s.state === 'done');
  // Open while there is something to watch; closed once it is history.
  const [open, setOpen] = useState(!landed);

  /**
   * The header shows even with NO acceptance plan, which is the case it now exists for.
   *
   * A branch without one cannot accept anything, and until this there was no way to see that or fix
   * it — the only route to a plan was persuading the planner to call `set_acceptance`. A follow-up
   * branch inherits its tree's, so this is the way out when that inherited nothing, or the wrong
   * thing.
   */
  const planned = Array.isArray(record?.acceptance) ? record.acceptance : [];
  const hasHeader = Boolean(record?.acceptance) || stages.length > 0 || Boolean(onSetAcceptance);
  const done = stages.filter((s) => s.state === 'done').length;

  const proposed = leaves
    .filter((l) => l.branchId === branchId && l.status === 'proposed')
    // `personaId` travels with the proposal: a persona carries the whole environment, so one
    // without it cannot run and must not look acceptable.
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
            {/* The single line that has to be true when it is shut. */}
            {!open && landed && <span className="text-[var(--leaf)] normal-case tracking-normal font-normal">delivered</span>}
            {!open && !landed && stages.length > 0 && (
              <span className="normal-case tracking-normal font-normal">
                {stages.find((s) => s.state !== 'done')?.label ?? 'in progress'}
              </span>
            )}
          </button>

          {open && (
            <div className="pb-2">
              {/* Display and editing are siblings, composed here: one component is responsible for
                  showing a plan, and a different one for changing it. */}
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
        {/* Not keyed on the branch: remounting is what discarded the transcript. The caller holds
            it per branch instead. */}
        <Chat
          apiBase={apiBase}
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
