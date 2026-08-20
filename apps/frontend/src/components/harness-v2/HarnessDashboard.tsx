import { useState, useEffect } from 'react';
import { Play, Pause, ShieldCheck, ShieldAlert, Cpu, Layers, RefreshCw, Terminal, Award, MessageSquare, ListTodo } from 'lucide-react';
import axios from 'axios';
import type { HarnessTask, TurnExecutionStep } from '@koala/harness-types';
import HarnessChatPane from './HarnessChatPane.js';

export default function HarnessDashboard() {
  const [tasks, setTasks] = useState<HarnessTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<HarnessTask | null>(null);
  const [traces, setTraces] = useState<TurnExecutionStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'tasks'>('chat');

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const res = await axios.get('/api/harness-v2/tasks');
      if (res.data.success) {
        setTasks(res.data.tasks);
        if (!selectedTaskId && res.data.tasks.length > 0) {
          setSelectedTaskId(res.data.tasks[0].id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch tasks', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTaskDetails = async (id: string) => {
    try {
      const res = await axios.get(`/api/harness-v2/tasks/${id}`);
      if (res.data.success) {
        setSelectedTask(res.data.task);
      }
    } catch (err) {
      console.error('Failed to fetch task details', err);
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
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (selectedTaskId) {
      fetchTaskDetails(selectedTaskId);
      fetchTraces(selectedTaskId);
    }
  }, [selectedTaskId]);

  const handleSelectTaskFromChat = (taskId: string) => {
    setSelectedTaskId(taskId);
    fetchTasks();
  };

  const togglePause = async (task: HarnessTask) => {
    const endpoint = task.status === 'paused' ? 'resume' : 'pause';
    try {
      await axios.post(`/api/harness-v2/tasks/${task.id}/${endpoint}`);
      fetchTasks();
      fetchTaskDetails(task.id);
    } catch (err) {
      console.error(`Failed to ${endpoint} task`, err);
    }
  };

  return (
    <div className="flex h-full w-full bg-[var(--bark-900)] text-slate-100 overflow-hidden font-sans">
      {/* Left Column: Switchable between Orchestrator Chat & Task Catalog */}
      <div className="w-[440px] border-r border-[var(--bark-600)] flex flex-col bg-[var(--bark-850)] flex-shrink-0">
        {/* Top Tab Bar */}
        <div className="flex border-b border-[var(--bark-600)] bg-[var(--bark-800)]">
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${
              activeTab === 'chat'
                ? 'text-[var(--leaf)] border-b-2 border-[var(--leaf)] bg-[var(--bark-750)]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare size={14} /> Orchestrator Chat
          </button>
          <button
            onClick={() => setActiveTab('tasks')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${
              activeTab === 'tasks'
                ? 'text-[var(--leaf)] border-b-2 border-[var(--leaf)] bg-[var(--bark-750)]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ListTodo size={14} /> Tasks ({tasks.length})
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'chat' ? (
            <HarnessChatPane onSelectTask={handleSelectTaskFromChat} />
          ) : (
            <div className="flex flex-col h-full overflow-y-auto divide-y divide-[var(--bark-700)]">
              <div className="p-3 border-b border-[var(--bark-600)] flex items-center justify-between bg-[var(--bark-800)]">
                <span className="text-xs font-bold text-slate-300">All Harness V2 Tasks</span>
                <button onClick={fetchTasks} className="p-1 hover:bg-[var(--bark-700)] rounded text-slate-400">
                  <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>
              {tasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  className={`p-3.5 cursor-pointer transition-colors ${
                    selectedTaskId === task.id ? 'bg-[var(--bark-700)] border-l-4 border-[var(--leaf)]' : 'hover:bg-[var(--bark-750)]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold truncate max-w-[260px]">{task.title}</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${
                        task.status === 'succeeded'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : task.status === 'running'
                          ? 'bg-sky-500/20 text-sky-300 animate-pulse'
                          : task.status === 'paused'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-red-500/20 text-red-300'
                      }`}
                    >
                      {task.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>Phase: {task.phase}</span>
                    <span>Turns: {task.budget.turnsCompleted}/{task.budget.maxTurns}</span>
                  </div>
                </div>
              ))}
              {tasks.length === 0 && (
                <div className="p-8 text-center text-xs text-slate-500">No tasks executed yet. Start chatting to propose one!</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Active Task Execution Viewer */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bark-900)]">
        {selectedTask ? (
          <>
            {/* Header */}
            <div className="p-4 border-b border-[var(--bark-600)] flex items-center justify-between bg-[var(--bark-800)]/50">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-base font-bold text-slate-100">{selectedTask.title}</h1>
                  <span className="text-xs px-2 py-0.5 rounded bg-[var(--bark-700)] text-slate-300 font-mono">
                    {selectedTask.id}
                  </span>
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
                <p className="text-xs text-slate-400 mt-1">{selectedTask.description || 'No description provided.'}</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => togglePause(selectedTask)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 rounded-lg text-xs font-semibold transition-colors"
                >
                  {selectedTask.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}
                  {selectedTask.status === 'paused' ? 'Resume' : 'Pause'}
                </button>
              </div>
            </div>

            {/* Scrollable Trace & Metric Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
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
                    <Award className={selectedTask.verdict.passed ? 'text-emerald-400' : 'text-red-400'} size={18} />
                    <h3 className="font-bold text-sm">Evaluator Scorecard: {selectedTask.verdict.score}/100</h3>
                  </div>
                  <p className="text-xs text-slate-300 mb-3">{selectedTask.verdict.evaluatorNotes}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(selectedTask.verdict.rubricBreakdown).map(([key, crit]) => (
                      <div
                        key={key}
                        className="p-2 bg-[var(--bark-800)]/80 rounded-lg text-[11px] border border-[var(--bark-700)] flex items-center justify-between"
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
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                    <Layers size={14} className="text-[var(--leaf)]" /> Durable Execution Trace ({traces.length} Turns)
                  </h3>
                </div>

                <div className="space-y-3">
                  {traces.map((step) => (
                    <div
                      key={step.turnIndex}
                      className="p-4 rounded-xl bg-[var(--bark-800)]/50 border border-[var(--bark-700)] space-y-3"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-slate-200">
                          Turn #{step.turnIndex} ({step.phase})
                        </span>
                        <div className="flex items-center gap-2">
                          {step.actionGate.passed ? (
                            <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded">
                              <ShieldCheck size={12} /> Action Gate Passed ({step.actionGate.riskLevel})
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] text-red-400 font-medium bg-red-500/10 px-2 py-0.5 rounded">
                              <ShieldAlert size={12} /> Refused: {step.actionGate.refusalReason}
                            </span>
                          )}
                          <span className="text-slate-500 font-mono text-[10px]">
                            {step.inference.promptTokens + step.inference.completionTokens} tok
                          </span>
                        </div>
                      </div>

                      {step.inference.content && (
                        <div className="text-xs text-slate-300 bg-[var(--bark-900)] p-3 rounded-lg border border-[var(--bark-700)]">
                          {step.inference.content}
                        </div>
                      )}

                      {/* Tool Executions */}
                      {step.toolResults.map((tr) => (
                        <div
                          key={tr.toolCallId}
                          className="p-2.5 bg-black/40 rounded-lg border border-[var(--bark-700)] font-mono text-[11px] space-y-1"
                        >
                          <div className="flex items-center justify-between text-slate-400">
                            <span className="flex items-center gap-1.5 text-slate-300">
                              <Terminal size={12} /> {tr.toolName}
                            </span>
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
                    <div className="p-6 text-center text-xs text-slate-500">
                      Waiting for turn-by-turn trace output...
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-500 space-y-2">
            <Cpu size={40} className="text-slate-600" />
            <p className="text-xs">Select or approve a Harness V2 task to view execution traces and evaluation metrics.</p>
          </div>
        )}
      </div>
    </div>
  );
}
