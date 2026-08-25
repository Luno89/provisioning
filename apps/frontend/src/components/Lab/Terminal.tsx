/**
 * A live sandbox under the verify command you are writing.
 *
 * ── WHY A TERMINAL AND NOT JUST THE GATE ──
 * The gate answers one question: does this command fail on the seed and pass on the solution. It
 * cannot say WHY it failed, and while writing one that is the only question you have. `node
 * read.js` exiting 1 could be a missing file, a syntax error, a wrong path, or a tool the image
 * does not carry — and telling those apart is one `ls` away.
 *
 * It is the same pod the agent gets, with the same seed, deliberately: a verify command tested
 * anywhere else is tested against an environment the run will not use.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, RotateCcw, Power } from 'lucide-react';
import { errorMessage } from './shared';
import { openWorkbench, execInWorkbench, resetWorkbench, deleteWorkbench } from '../../api/harness';

interface Line {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export function Terminal({ seed, language, field, heading,
}: {
  seed: { path: string; content: string }[];
  language?: string | undefined;
  field: string;
  heading: string;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState('');

  const open = useMutation({
    mutationFn: () => openWorkbench({ seed, language }) as Promise<{ sessionId: string }>,
    onSuccess: (d) => { setSessionId(d.sessionId); setError(''); },
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const run = useMutation({
    mutationFn: (cmd: string) =>
      execInWorkbench({ sessionId, command: cmd }) as Promise<Omit<Line, 'command'>>,
    onSuccess: (d, cmd) => { setLines((l) => [...l, { command: cmd, ...d }].slice(-40)); setError(''); },
    onError: (err: unknown) => {
      // The idle reaper takes sessions, so a dead one is expected rather than exceptional — say so
      // and drop the id, which turns the button back into "Open sandbox".
      setError(errorMessage(err));
      setSessionId(null);
    },
  });

  const reset = useMutation({
    mutationFn: () => resetWorkbench({ sessionId, seed }),
    onSuccess: () => { setLines([]); setError(''); },
    onError: (err: unknown) => { setError(errorMessage(err)); setSessionId(null); },
  });

  const close = useMutation({
    mutationFn: () => deleteWorkbench(sessionId!),
    onSuccess: () => { setSessionId(null); setLines([]); },
  });

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <p className={heading}>Sandbox</p>
        {sessionId ? (
          <>
            <button
              onClick={() => reset.mutate()}
              title="Wipe and re-apply the seed — iterate against the state a run would start from"
              className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300"
            >
              <RotateCcw size={10} /> reset
            </button>
            <button
              onClick={() => close.mutate()}
              title="Destroy the pod"
              className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-red-400"
            >
              <Power size={10} /> close
            </button>
          </>
        ) : (
          <button
            onClick={() => open.mutate()}
            disabled={open.isPending}
            className="flex items-center gap-1 text-[10px] text-[var(--leaf-light)] hover:text-white disabled:opacity-50"
          >
            {open.isPending && <Loader2 size={10} className="animate-spin" />}
            open sandbox
          </button>
        )}
      </div>

      {!sessionId && !open.isPending && (
        <p className="text-[10px] text-slate-600 leading-snug">
          {/* Said plainly: it is a real pod, and the seed is what makes it worth testing against. */}
          Starts a real pod with this task's seed applied — the same environment the agent gets.
        </p>
      )}

      {lines.length > 0 && (
        <div className="bg-[var(--bark-900)] border border-[var(--bark-600)] rounded p-2 max-h-56 overflow-y-auto space-y-1.5 mb-1">
          {lines.map((l, i) => (
            <div key={i}>
              <p className="text-[10px] font-mono text-slate-300">
                <span className="text-slate-600">$ </span>{l.command}
              </p>
              {(l.stdout || l.stderr) && (
                <pre className="text-[10px] font-mono text-slate-500 whitespace-pre-wrap">
                  {[l.stdout, l.stderr].filter(Boolean).join('\n').slice(-2000)}
                </pre>
              )}
              <p className={`text-[9px] ${l.exitCode === 0 ? 'text-slate-600' : 'text-amber-400'}`}>
                {l.timedOut ? 'timed out' : `exit ${l.exitCode}`}
              </p>
            </div>
          ))}
        </div>
      )}

      {sessionId && (
        <input
          className={`${field} py-1`}
          placeholder="ls -la · node read.js · cat data.txt"
          value={command}
          disabled={run.isPending}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !command.trim()) return;
            run.mutate(command);
            setCommand('');
          }}
        />
      )}

      {error && <p className="text-[10px] text-amber-400 mt-1">{error}</p>}
    </div>
  );
}
