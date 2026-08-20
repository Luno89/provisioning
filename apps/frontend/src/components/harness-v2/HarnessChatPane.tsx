import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import {
  Send,
  Plus,
  Play,
  Sparkles,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Layers,
  Award,
  Server,
  Activity,
  Cpu,
  BookOpen,
} from 'lucide-react';
import type { HarnessConversation, ProposedHarnessTask } from '@koala/harness-types';

export default function HarnessChatPane({
  onSelectTask,
  activeTaskId: _activeTaskId,
}: {
  onSelectTask: (taskId: string) => void;
  activeTaskId?: string | null;
}) {
  const [conversations, setConversations] = useState<HarnessConversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<HarnessConversation | null>(null);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const fetchConversations = async () => {
    try {
      const res = await axios.get('/api/harness-v2/conversations');
      if (res.data.success) {
        setConversations(res.data.conversations);
        if (!selectedConvId && res.data.conversations.length > 0) {
          setSelectedConvId(res.data.conversations[0].id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch conversations', err);
    }
  };

  const fetchActiveConversation = async (id: string) => {
    try {
      const res = await axios.get(`/api/harness-v2/conversations/${id}`);
      if (res.data.success) {
        setActiveConversation(res.data.conversation);
      }
    } catch (err) {
      console.error('Failed to fetch active conversation', err);
    }
  };

  useEffect(() => {
    fetchConversations();
  }, []);

  useEffect(() => {
    if (selectedConvId) {
      fetchActiveConversation(selectedConvId);
    }
  }, [selectedConvId]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages, loading]);

  const createConversation = async () => {
    try {
      const res = await axios.post('/api/harness-v2/conversations', {});
      if (res.data.success) {
        await fetchConversations();
        setSelectedConvId(res.data.conversation.id);
      }
    } catch (err) {
      console.error('Failed to create conversation', err);
    }
  };

  const sendMessage = async (customPrompt?: string) => {
    const textToSend = customPrompt || inputText;
    if (!textToSend.trim() || !selectedConvId || loading) return;

    setInputText('');
    setLoading(true);

    try {
      const res = await axios.post(`/api/harness-v2/conversations/${selectedConvId}/messages`, {
        content: textToSend.trim(),
      });
      if (res.data.success) {
        await fetchActiveConversation(selectedConvId);
        await fetchConversations();
      }
    } catch (err) {
      console.error('Failed to send message', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };

  const acceptProposal = async (proposal: ProposedHarnessTask) => {
    if (!selectedConvId) return;
    try {
      const res = await axios.post(`/api/harness-v2/conversations/${selectedConvId}/proposals/${proposal.id}/accept`);
      if (res.data.success) {
        await fetchActiveConversation(selectedConvId);
        onSelectTask(res.data.task.id);
      }
    } catch (err) {
      console.error('Failed to accept proposal', err);
    }
  };

  const toggleReasoning = (msgId: string) => {
    setExpandedReasoning((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  return (
    <div className="flex h-full w-full bg-[var(--bark-900)] text-slate-100 overflow-hidden font-sans">
      {/* Collapsible Session History Sidebar */}
      {sidebarOpen && (
        <div className="w-64 border-r border-[var(--bark-600)] flex flex-col bg-[var(--bark-850)] flex-shrink-0">
          <div className="p-3 border-b border-[var(--bark-600)] flex items-center justify-between bg-[var(--bark-800)]">
            <div className="flex items-center gap-2">
              <Cpu size={16} className="text-[var(--leaf)]" />
              <span className="text-xs font-bold uppercase tracking-wide">Sessions</span>
            </div>
            <button
              onClick={createConversation}
              className="flex items-center gap-1 px-2 py-1 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white rounded text-[11px] font-semibold transition-colors"
            >
              <Plus size={12} /> New
            </button>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[var(--bark-750)]">
            {conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => setSelectedConvId(conv.id)}
                className={`p-3 cursor-pointer text-xs transition-colors flex flex-col gap-1 ${
                  selectedConvId === conv.id
                    ? 'bg-[var(--bark-700)] border-l-4 border-[var(--leaf)] text-white'
                    : 'text-slate-400 hover:bg-[var(--bark-800)] hover:text-slate-200'
                }`}
              >
                <div className="font-semibold truncate">{conv.title}</div>
                <div className="text-[10px] text-slate-500 font-mono">
                  {new Date(conv.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}
            {conversations.length === 0 && (
              <div className="p-6 text-center text-xs text-slate-500">No sessions yet.</div>
            )}
          </div>
        </div>
      )}

      {/* Main Conversational Canvas */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bark-900)]">
        {/* Header with Quick Tools & Sidebar Toggle */}
        <div className="p-3.5 border-b border-[var(--bark-600)] bg-[var(--bark-800)]/70 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen((o) => !o)}
              className="text-xs px-2.5 py-1 bg-[var(--bark-700)] hover:bg-[var(--bark-600)] rounded text-slate-300 font-semibold transition-colors"
            >
              {sidebarOpen ? 'Hide History' : 'Show History'}
            </button>
            <h1 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Sparkles size={16} className="text-[var(--leaf)]" />
              {activeConversation?.title || 'Harness Orchestrator'}
            </h1>
          </div>

          {/* Quick Action Badges */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => sendMessage('what is deployed in the cluster infrastructure?')}
              className="flex items-center gap-1 px-2.5 py-1 bg-[var(--bark-700)] hover:bg-[var(--bark-650)] text-slate-300 rounded-full text-[11px] font-medium transition-colors"
            >
              <Server size={12} className="text-sky-400" /> Inspect Cluster
            </button>
            <button
              onClick={() => sendMessage('list all active harness v2 tasks and their evaluation results')}
              className="flex items-center gap-1 px-2.5 py-1 bg-[var(--bark-700)] hover:bg-[var(--bark-650)] text-slate-300 rounded-full text-[11px] font-medium transition-colors"
            >
              <Activity size={12} className="text-emerald-400" /> Active Tasks
            </button>
          </div>
        </div>

        {/* Messages Stream */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-4xl w-full mx-auto">
          {activeConversation?.messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} space-y-2`}
            >
              <div className="flex items-center gap-2 text-[10px] uppercase font-bold text-slate-400">
                {msg.role === 'user' ? (
                  <span>You</span>
                ) : (
                  <span className="flex items-center gap-1 text-[var(--leaf)]">
                    <Sparkles size={11} /> Harness Orchestrator
                  </span>
                )}
                <span>• {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>

              {/* Collapsible Reasoning */}
              {msg.reasoning && (
                <div className="w-full max-w-2xl bg-black/25 rounded-xl border border-[var(--bark-700)] text-xs overflow-hidden">
                  <button
                    onClick={() => toggleReasoning(msg.id)}
                    className="w-full px-3.5 py-2 flex items-center justify-between text-slate-400 hover:text-slate-200 transition-colors text-[11px]"
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      <BookOpen size={12} className="text-[var(--leaf)]" /> Orchestrator Reasoning & Plan
                    </span>
                    {expandedReasoning[msg.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  {expandedReasoning[msg.id] && (
                    <div className="px-3.5 pb-3 text-slate-300 text-[11px] border-t border-[var(--bark-700)]/60 pt-2 font-mono whitespace-pre-wrap leading-relaxed">
                      {msg.reasoning}
                    </div>
                  )}
                </div>
              )}

              {/* Message Bubble */}
              <div
                className={`p-4 rounded-2xl text-xs max-w-2xl leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-[var(--leaf-stem)] text-white shadow-md'
                    : 'bg-[var(--bark-800)] text-slate-200 border border-[var(--bark-700)] shadow-lg'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>

                {/* Proposed Task Cards */}
                {msg.proposals && msg.proposals.length > 0 && (
                  <div className="mt-4 space-y-3 pt-3 border-t border-[var(--bark-700)]">
                    {msg.proposals.map((prop) => (
                      <div
                        key={prop.id}
                        className="p-4 rounded-xl bg-[var(--bark-900)] border border-[var(--bark-600)] space-y-3 shadow-inner"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Layers size={16} className="text-[var(--leaf)]" />
                            <span className="font-bold text-slate-100 text-xs">{prop.title}</span>
                          </div>
                          <span
                            className={`text-[10px] px-2.5 py-0.5 rounded-full uppercase font-medium ${
                              prop.status === 'accepted'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-sky-500/20 text-sky-300 animate-pulse'
                            }`}
                          >
                            {prop.status}
                          </span>
                        </div>

                        <p className="text-[11px] text-slate-300 leading-normal">{prop.description}</p>

                        <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 bg-black/40 p-2.5 rounded-lg border border-[var(--bark-700)]">
                          <div>Persona: <span className="font-semibold text-slate-200">{prop.personaId}</span></div>
                          <div>Dynamic Budget: <span className="font-semibold text-slate-200">{prop.budget.maxTurns} turns</span></div>
                        </div>

                        {/* Rubrics Preview */}
                        {prop.rubrics && (
                          <div className="space-y-1.5 bg-[var(--bark-850)] p-2.5 rounded-lg border border-[var(--bark-750)]">
                            <div className="text-[10px] font-bold text-slate-300 flex items-center gap-1.5 uppercase tracking-wider">
                              <Award size={13} className="text-amber-400" /> Evaluation Rubric Breakdown:
                            </div>
                            <div className="space-y-1">
                              {prop.rubrics.map((r) => (
                                <div key={r.name} className="text-[11px] text-slate-300 flex justify-between">
                                  <span>• {r.description}</span>
                                  <span className="font-mono text-slate-400 font-semibold">{Math.round(r.weight * 100)}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Action Button */}
                        {prop.status === 'proposed' ? (
                          <button
                            onClick={() => acceptProposal(prop)}
                            className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white text-xs font-bold rounded-lg transition-all shadow-md active:scale-[0.99]"
                          >
                            <Play size={13} /> Approve & Launch Task in Temporal
                          </button>
                        ) : (
                          <button
                            onClick={() => prop.taskId && onSelectTask(prop.taskId)}
                            className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 text-xs font-semibold rounded-lg transition-colors"
                          >
                            <CheckCircle2 size={13} className="text-emerald-400" /> Open Execution Inspector
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2.5 text-xs text-slate-400 italic p-3 bg-[var(--bark-800)]/40 rounded-xl border border-[var(--bark-700)] w-fit">
              <Sparkles size={14} className="animate-spin text-[var(--leaf)]" />
              Orchestrator is deliberating and querying platform tools...
            </div>
          )}
          <div ref={scrollEndRef} />
        </div>

        {/* Global Prompt Bar */}
        <div className="p-4 border-t border-[var(--bark-600)] bg-[var(--bark-800)]/90">
          <form onSubmit={handleSubmit} className="max-w-4xl mx-auto flex gap-3">
            <input
              type="text"
              placeholder="Ask anything: 'Search web for...', 'Implement feature...', 'Inspect cluster logs'..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={loading}
              className="flex-1 px-4 py-2.5 text-xs bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[var(--leaf)] shadow-inner"
            />
            <button
              type="submit"
              disabled={loading || !inputText.trim()}
              className="px-5 py-2.5 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-50 text-white font-semibold text-xs rounded-xl transition-all shadow flex items-center gap-2"
            >
              <Send size={13} /> Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
