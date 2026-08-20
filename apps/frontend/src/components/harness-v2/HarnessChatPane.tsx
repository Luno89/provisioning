import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Send, Plus, Play, Sparkles, CheckCircle2, ChevronDown, ChevronRight, Layers, Award } from 'lucide-react';
import type { HarnessConversation, ProposedHarnessTask } from '@koala/harness-types';

export default function HarnessChatPane({
  onSelectTask,
}: {
  onSelectTask: (taskId: string) => void;
}) {
  const [conversations, setConversations] = useState<HarnessConversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<HarnessConversation | null>(null);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
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

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !selectedConvId || loading) return;

    const userContent = inputText.trim();
    setInputText('');
    setLoading(true);

    try {
      const res = await axios.post(`/api/harness-v2/conversations/${selectedConvId}/messages`, {
        content: userContent,
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
    <div className="flex flex-col h-full bg-[var(--bark-850)] border-r border-[var(--bark-600)] font-sans">
      {/* Top Header & Session Switcher */}
      <div className="p-3 border-b border-[var(--bark-600)] bg-[var(--bark-800)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-[var(--leaf)]" />
          {conversations.length > 1 ? (
            <select
              value={selectedConvId || ''}
              onChange={(e) => setSelectedConvId(e.target.value)}
              className="text-xs font-bold bg-[var(--bark-900)] border border-[var(--bark-600)] text-slate-200 rounded px-2 py-0.5"
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          ) : (
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Orchestrator Planning</h2>
          )}
        </div>
        <button
          onClick={createConversation}
          className="flex items-center gap-1 px-2 py-1 bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 rounded text-xs transition-colors"
        >
          <Plus size={13} /> New Session
        </button>
      </div>

      {/* Messages Timeline */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeConversation?.messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} space-y-1.5`}
          >
            <div className="text-[10px] uppercase font-bold text-slate-400">
              {msg.role === 'user' ? 'You' : 'Harness Orchestrator'}
            </div>

            {/* Deliberation / Reasoning Accordion */}
            {msg.reasoning && (
              <div className="w-full max-w-[90%] bg-black/20 rounded-lg border border-[var(--bark-700)] text-xs overflow-hidden">
                <button
                  onClick={() => toggleReasoning(msg.id)}
                  className="w-full px-3 py-1.5 flex items-center gap-1.5 text-slate-400 hover:text-slate-200 transition-colors text-[11px]"
                >
                  {expandedReasoning[msg.id] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>Orchestrator Deliberation</span>
                </button>
                {expandedReasoning[msg.id] && (
                  <div className="px-3 pb-2.5 text-slate-300 text-[11px] border-t border-[var(--bark-700)]/50 pt-2 font-mono whitespace-pre-wrap">
                    {msg.reasoning}
                  </div>
                )}
              </div>
            )}

            {/* Message Bubble */}
            <div
              className={`p-3.5 rounded-xl text-xs max-w-[90%] leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-[var(--leaf-stem)] text-white'
                  : 'bg-[var(--bark-800)] text-slate-200 border border-[var(--bark-700)]'
              }`}
            >
              <div className="whitespace-pre-wrap">{msg.content}</div>

              {/* Proposed Task Cards */}
              {msg.proposals && msg.proposals.length > 0 && (
                <div className="mt-3 space-y-2.5 pt-2 border-t border-[var(--bark-700)]">
                  {msg.proposals.map((prop) => (
                    <div
                      key={prop.id}
                      className="p-3.5 rounded-lg bg-[var(--bark-900)] border border-[var(--bark-600)] space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Layers size={14} className="text-[var(--leaf)]" />
                          <span className="font-bold text-slate-100 text-xs">{prop.title}</span>
                        </div>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-medium ${
                            prop.status === 'accepted'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-sky-500/20 text-sky-300 animate-pulse'
                          }`}
                        >
                          {prop.status}
                        </span>
                      </div>

                      <p className="text-[11px] text-slate-300">{prop.description}</p>

                      <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400 bg-black/30 p-2 rounded">
                        <div>Persona: <span className="font-semibold text-slate-200">{prop.personaId}</span></div>
                        <div>Budget: <span className="font-semibold text-slate-200">{prop.budget.maxTurns} turns</span></div>
                      </div>

                      {/* Rubrics Preview */}
                      {prop.rubrics && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-semibold text-slate-400 flex items-center gap-1">
                            <Award size={11} className="text-amber-400" /> Evaluation Rubric:
                          </div>
                          <div className="space-y-0.5">
                            {prop.rubrics.map((r) => (
                              <div key={r.name} className="text-[10px] text-slate-300 flex justify-between">
                                <span>• {r.description}</span>
                                <span className="font-mono text-slate-400">({Math.round(r.weight * 100)}%)</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Action Button */}
                      {prop.status === 'proposed' ? (
                        <button
                          onClick={() => acceptProposal(prop)}
                          className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white text-xs font-semibold rounded-lg transition-colors"
                        >
                          <Play size={12} /> Approve & Launch Task
                        </button>
                      ) : (
                        <button
                          onClick={() => prop.taskId && onSelectTask(prop.taskId)}
                          className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 text-xs font-semibold rounded-lg transition-colors"
                        >
                          <CheckCircle2 size={12} className="text-emerald-400" /> View Live Execution
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
          <div className="flex items-center gap-2 text-xs text-slate-400 italic p-2">
            <Sparkles size={14} className="animate-spin text-[var(--leaf)]" />
            Orchestrator is deliberating...
          </div>
        )}
        <div ref={scrollEndRef} />
      </div>

      {/* Message Composer */}
      <form onSubmit={sendMessage} className="p-3 border-t border-[var(--bark-600)] bg-[var(--bark-800)] flex gap-2">
        <input
          type="text"
          placeholder="Ask orchestrator to plan, implement, or research..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          disabled={loading}
          className="flex-1 px-3 py-2 text-xs bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg text-slate-200 focus:outline-none focus:border-[var(--leaf)]"
        />
        <button
          type="submit"
          disabled={loading || !inputText.trim()}
          className="px-3 py-2 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
