import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Check, X } from 'lucide-react';
import { errorMessage, type ExperimentTask } from './shared';
import { authorChat } from '../../api/harness';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

type Revision = Partial<Pick<ExperimentTask, 'prompt' | 'verifyCommand' | 'seed' | 'solution'>>;

const changedFields = (r: Revision): string[] => Object.keys(r);

export function TaskChat({ task, field, onAccept,
}: {
  task: ExperimentTask | undefined;
  field: string;
  onAccept: (revision: Revision) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Revision | null>(null);
  const [error, setError] = useState('');

  const send = useMutation({
    mutationFn: (text: string) => {
      const next: Turn[] = [...turns, { role: 'user', content: text }];
      setTurns(next);
      return authorChat({ task, messages: next }) as Promise<{ reply: string; revision: Revision | null }>;
    },
    onSuccess: (d) => {
      setError('');
      setTurns((t) => [...t, { role: 'assistant', content: d.reply || '(proposed a change)' }]);
      if (d.revision) setPending(d.revision);
    },
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto space-y-2 mb-2 min-h-0">
        {turns.length === 0 && (
          <p className="text-[11px] text-slate-600 leading-snug">
            Ask about this task — whether the prompt is answerable from the seed, what the verify
            command should check, why a run failed. Koala can propose changes to the prompt, seed,
            solution and verify together.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i}>
            <p className={`text-[9px] uppercase tracking-widest mb-0.5 ${
              t.role === 'user' ? 'text-slate-600' : 'text-[var(--leaf-light)]'
            }`}>
              {t.role === 'user' ? 'you' : 'koala'}
            </p>
            <p className="text-[11px] text-slate-400 whitespace-pre-wrap leading-relaxed">{t.content}</p>
          </div>
        ))}
        {send.isPending && (
          <p className="text-[10px] text-slate-600 flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" /> thinking
          </p>
        )}
      </div>

      {pending && (
        <div className="bg-[var(--bark-800)]/70 border border-[var(--leaf-stem)]/50 rounded p-2 mb-2">
          <p className="text-[10px] text-slate-300 mb-1">
            {`Proposed change to ${changedFields(pending).join(', ')}`}
          </p>
          <pre className="text-[10px] text-slate-500 whitespace-pre-wrap max-h-32 overflow-y-auto mb-1.5">
            {JSON.stringify(pending, null, 1)}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { onAccept(pending); setPending(null); }}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white"
            >
              <Check size={10} /> apply
            </button>
            <button
              onClick={() => setPending(null)}
              className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300"
            >
              <X size={10} /> discard
            </button>
            <span className="text-[9px] text-slate-600">applies to the editors — still unsaved</span>
          </div>
        </div>
      )}

      {error && <p className="text-[10px] text-amber-400 mb-1">{error}</p>}

      <input
        className={`${field} py-1 shrink-0`}
        placeholder="ask about this task…"
        value={draft}
        disabled={send.isPending || !task}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !draft.trim()) return;
          send.mutate(draft);
          setDraft('');
        }}
      />
    </div>
  );
}
