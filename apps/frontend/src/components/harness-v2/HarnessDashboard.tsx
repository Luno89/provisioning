import { useState, useEffect } from 'react';
import { Play, Pause, ShieldCheck, ShieldAlert, Layers, RefreshCw, Terminal, Award, X, Activity } from 'lucide-react';
import axios from 'axios';
import type { HarnessTask, TurnExecutionStep } from '@koala/harness-types';
import HarnessChatPane from './HarnessChatPane.js';

export default function HarnessDashboard() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<HarnessTask | null>(null);
  const [traces, setTraces] = useState<TurnExecutionStep[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchTaskDetails = async (id: string) => {
    try {
      setLoading(true);
      const res = await axios.get(`/api/harness-v2/tasks/${id}`);
      if (res.data.success) {
        setSelectedTask(res.data.task);
      }
    } catch (err) {
      console.error('Failed to fetch task details', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTraces = async (taskId: string) => {
    try {
      const res = await axios.get(`/api/harness-v2/tasks/${taskId}/traces`);
      if (res.data.success) {
        setTraces(res.data.traces);
      }
    } catch (err) {
      console.error('Failed to fetch traces', err);
    }
  };

  useEffect(() => {
    if (selectedTaskId) {
      fetchTaskDetails(selectedTaskId);
      fetchTraces(selectedTaskId);
      const interval = setInterval(() => {
        fetchTaskDetails(selectedTaskId);
        fetchTraces(selectedTaskId);
      }, 4000);
      return () => clearInterval(interval);
    }
  }, [selectedTaskId]);

  const handleSelectTaskFromChat = (taskId: string) => {
    setSelectedTaskId(taskId);
    setInspectorOpen(true);
  };

  const togglePause = async (task: HarnessTask) => {
    const endpoint = task.status === 'paused' ? 'resume' : 'pause';
    try {
      await axios.post(`/api/harness-v2/tasks/${task.id}/${endpoint}`);
      fetchTaskDetails(task.id);
    } catch (err) {
      console.error(`Failed to ${endpoint} task`, err);
    }
  };

  return (
    <div className="relative flex h-full w-full bg-[var(--bark-900)] text-slate-100 overflow-hidden font-sans">
      {/* Primary Full-Canvas Conversational Workspace */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <HarnessChatPane onSelectTask={handleSelectTaskFromChat} activeTaskId={selectedTaskId} />
      </div>

      {/* Floating Execution Quick-Bar if Task is Active & Drawer is Closed */}
      {selectedTask && !inspectorOpen && (
        <div className="absolute top-3 right-4 z-20 flex items-center gap-3 px-4 py-2 bg-[var(--bark-800)]/95 border border-[var(--bark-600)] rounded-xl shadow-2xl backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-xs font-semibold text-slate-200 truncate max-w-[200px]">{selectedTask.title}</span>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full uppercase font-mono font-medium bg-sky-500/20 text-sky-300">
            Turn {selectedTask.budget.turnsCompleted}/{selectedTask.budget.maxTurns}
          </span>
          <button
            onClick={() => setInspectorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white rounded-lg text-xs font-semibold transition-colors"
          >
            <Activity size={12} /> Inspect Live
          </button>
        </div>
      )}

      {/* Slide-Over Execution Inspector Drawer */}
      {inspectorOpen && selectedTask && (
        <div className="w-[520px] border-l border-[var(--bark-600)] flex flex-col h-full bg-[var(--bark-850)] shadow-2xl flex-shrink-0 z-30 animate-in slide-in-from-right duration-200">
          {/* Drawer Header */}
          <div className="p-4 border-b border-[var(--bark-600)] bg-[var(--bark-800)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers size={18} className="text-[var(--leaf)]" />
              <div>
                <h2 className="text-xs font-bold text-slate-100 uppercase tracking-wider">Live Execution Inspector</h2>
                <div className="text-[11px] text-slate-400 font-mono">{selectedTask.id}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => togglePause(selectedTask)}
                className="flex items-center gap-1 px-2.5 py-1 bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 rounded text-xs font-semibold transition-colors"
              >
                {selectedTask.status === 'paused' ? <Play size={12} /> : <Pause size={12} />}
                {selectedTask.status === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={() => {
                  fetchTaskDetails(selectedTask.id);
                  fetchTraces(selectedTask.id);
                }}
                className="p-1 hover:bg-[var(--bark-700)] rounded text-slate-400"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => setInspectorOpen(false)}
                className="p-1 hover:bg-[var(--bark-700)] rounded text-slate-400 hover:text-slate-200"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Task Overview */}
            <div className="p-3.5 bg-[var(--bark-900)] rounded-xl border border-[var(--bark-700)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-100">{selectedTask.title}</span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${
                    selectedTask.status === 'succeeded'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : selectedTask.status === 'running'
                      ? 'bg-sky-500/20 text-sky-300 animate-pulse'
                      : selectedTask.status === 'paused'
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-red-500/20 text-red-300'
                  }`}
                >
                  {selectedTask.status}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400 bg-black/30 p-2 rounded">
                <div>Phase: <span className="font-semibold text-slate-200">{selectedTask.phase}</span></div>
                <div>Turns: <span className="font-semibold text-slate-200">{selectedTask.budget.turnsCompleted}/{selectedTask.budget.maxTurns}</span></div>
              </div>
            </div>

            {/* Evaluator Scorecard */}
            {selectedTask.verdict && (
              <div
                className={`p-4 rounded-xl border ${
                  selectedTask.verdict.passed
                    ? 'bg-emerald-950/20 border-emerald-800/50'
                    : 'bg-red-950/20 border-red-800/50'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Award className={selectedTask.verdict.passed ? 'text-emerald-400' : 'text-red-400'} size={16} />
                  <h3 className="font-bold text-xs">Evaluator Scorecard: {selectedTask.verdict.score}/100</h3>
                </div>
                <p className="text-[11px] text-slate-300 mb-2.5">{selectedTask.verdict.evaluatorNotes}</p>
                <div className="space-y-1.5">
                  {Object.entries(selectedTask.verdict.rubricBreakdown).map(([key, crit]) => (
                    <div
                      key={key}
                      className="p-2 bg-[var(--bark-800)]/80 rounded-lg text-[10px] border border-[var(--bark-700)] flex items-center justify-between"
                    >
                      <span className="font-mono text-slate-300">{key}</span>
                      <span className={crit.passed ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                        {crit.score} pts
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Turn-by-Turn Trace Stream */}
            <div className="space-y-3">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Terminal size={13} className="text-[var(--leaf)]" /> Durable Execution Trace ({traces.length} Turns)
              </h3>

              {traces.map((step) => (
                <div
                  key={step.turnIndex}
                  className="p-3.5 rounded-xl bg-[var(--bark-900)] border border-[var(--bark-700)] space-y-2.5 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200 text-[11px]">Turn #{step.turnIndex} ({step.phase})</span>
                    {step.actionGate.passed ? (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded font-medium">
                        <ShieldCheck size={11} /> Passed ({step.actionGate.riskLevel})
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] text-red-400 bg-red-500/10 px-2 py-0.5 rounded font-medium">
                        <ShieldAlert size={11} /> Refused: {step.actionGate.refusalReason}
                      </span>
                    )}
                  </div>

                  {step.inference.content && (
                    <div className="p-2.5 bg-black/40 rounded-lg text-[11px] text-slate-300 border border-[var(--bark-750)]">
                      {step.inference.content}
                    </div>
                  )}

                  {step.toolResults.map((tr) => (
                    <div
                      key={tr.toolCallId}
                      className="p-2 bg-black/50 rounded font-mono text-[10px] space-y-1 border border-[var(--bark-750)]"
                    >
                      <div className="flex items-center justify-between text-slate-400">
                        <span>▶ {tr.toolName}</span>
                        <span className={tr.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>
                          exit {tr.exitCode ?? 0}
                        </span>
                      </div>
                      {tr.stdout && <pre className="text-slate-300 whitespace-pre-wrap">{tr.stdout}</pre>}
                      {tr.stderr && <pre className="text-red-400 whitespace-pre-wrap">{tr.stderr}</pre>}
                    </div>
                  ))}
                </div>
              ))}

              {traces.length === 0 && (
                <div className="p-6 text-center text-xs text-slate-500">Waiting for turn-by-turn trace output...</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
