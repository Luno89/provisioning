/* ═══════════════ ChatSurface — unified persona-pack chat surface ═══════════════ */

/**
 * A single chat surface that works for ANY persona pack.
 *
 * - Streams from POST /api/chat-pack/:packId (unified wire)
 * - Parses SSE via lib/parse-sse
 * - Reduces frames via lib/chat-unified-reducer
 * - Renders live text, thinking, tool pills, enabled services
 *
 * Replaces both the harness Chat.tsx (provider passthrough) and KoalaChat.tsx
 * (Koala's own envelope). The pack's `delivery` flags control what shows.
 */
import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react';
import { openChatPackStream } from '../api/chat-pack.js';
import { parseSseStream } from '../lib/parse-sse.js';
import { reduceUnifiedFrames, type ChatRenderState } from '../lib/chat-unified-reducer.js';

interface ChatSurfaceProps {
  /** The persona pack ID (koala, researcher, harness, etc.) */
  packId: string;
  /** Optional existing conversation to resume. */
  conversationId?: string;
  /** Optional sessionId for koala-style context. */
  sessionId?: string;
  /** Optional model override. */
  modelId?: string;
  /** Optional initial messages for display (hydration). */
  initialMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export default function ChatSurface({
  packId,
  conversationId,
  sessionId,
  modelId,
  initialMessages = [],
}: ChatSurfaceProps) {
  const [state, setState] = useState<ChatRenderState>({
    live: '', liveThinking: '', tools: [], enabled: [], proposals: [],
  });
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.live, state.tools, state.enabled]);

  const sendMessage = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setError(null);
    setStreaming(true);

    // Reset live content for the new turn (history handled by parent if needed)
    setState((s) => ({ ...s, live: '', liveThinking: '', tools: [], enabled: [], proposals: [] }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await openChatPackStream(
        { packId, message: text, ...(conversationId ? { conversationId } : {}), ...(sessionId ? { sessionId } : {}), ...(modelId ? { modelId } : {}) },
        controller.signal,
      );

      const decoder = new TextDecoder();
      let buffered = '';
      const reader = res.body!.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const chunks = buffered.split('\n');
        buffered = chunks.pop() ?? '';
        for (const line of chunks) {
          const frames = [...parseSseStream([line + '\n'])];
          for (const frame of frames) {
            setState((s) => reduceUnifiedFrames(s, frame));
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') setError(err.message ?? 'Stream failed');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [packId, conversationId, sessionId, modelId, input, streaming]);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="chat-surface" style={styles.container}>
      {/* History would be rendered here — parent passes initialMessages */}
      {initialMessages.map((m, i) => (
        <div key={i} style={styles.historyMessage}>
          <strong>{m.role === 'user' ? 'You' : 'Assistant'}:</strong> {m.content}
        </div>
      ))}

      {/* Live streaming content */}
      <div style={styles.liveArea}>
        {state.liveThinking && (
          <details style={styles.thinking} open>
            <summary>Thinking…</summary>
            <pre style={styles.thinkingContent}>{state.liveThinking}</pre>
          </details>
        )}
        {state.live && <div style={styles.liveText}>{state.live}</div>}
        <div ref={messagesEndRef} />
      </div>

      {/* Tool pills */}
      {state.tools.length > 0 && (
        <div style={styles.toolBar}>
          {state.tools.map((t) => (
            <div key={t.id} style={{ ...styles.toolPill, ...(t.running ? styles.running : t.ok ? styles.ok : styles.err) }}>
              <span>{t.name}</span>
              {t.running ? <span className="spinner" /> : t.digest && <span style={styles.digest}>{t.digest}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Enabled services banner */}
      {state.enabled.length > 0 && (
        <div style={styles.enabledBar}>
          Enabled: {state.enabled.join(', ')}
        </div>
      )}

      {/* Error banner */}
      {error && <div style={styles.error}>Error: {error}</div>}

      {/* Input form */}
      <form onSubmit={sendMessage} style={styles.form} role="form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message..."
          disabled={streaming}
          style={styles.input}
        />
        <div style={styles.buttonRow}>
          {streaming ? (
            <button type="button" onClick={stopStream} style={styles.stopBtn}>Stop</button>
          ) : (
            <button type="submit" disabled={!input.trim()} style={styles.sendBtn}>Send</button>
          )}
        </div>
      </form>
    </div>
  );
}

// Inline styles for zero-dep testability; real app uses CSS modules.
const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: 8, padding: 16, maxWidth: 800, margin: '0 auto' },
  historyMessage: { opacity: 0.7, fontSize: 14 },
  liveArea: { minHeight: 60 },
  thinking: { border: '1px solid #444', borderRadius: 4, padding: 8, background: '#1a1a2e' },
  thinkingContent: { whiteSpace: 'pre-wrap', fontSize: 12, color: '#88f' },
  liveText: { whiteSpace: 'pre-wrap', fontSize: 15 },
  toolBar: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  toolPill: { display: 'flex', alignItems: 'center', gap: 6, padding: '4 8', borderRadius: 12, fontSize: 12 },
  running: { background: '#333', color: '#ffb' },
  ok: { background: '#1a3a1a', color: '#8f8' },
  err: { background: '#3a1a1a', color: '#f88' },
  digest: { fontSize: 11, opacity: 0.8 },
  enabledBar: { fontSize: 12, opacity: 0.6, padding: 4 },
  error: { color: '#f88', fontSize: 13 },
  form: { display: 'flex', gap: 8, alignItems: 'center' },
  input: { flex: 1, padding: '8 12', borderRadius: 4, border: '1px solid #444', background: '#1a1a1a', color: '#fff' },
  buttonRow: { display: 'flex', gap: 8 },
  sendBtn: { padding: '8 16', borderRadius: 4, background: '#2a2', border: 'none', color: '#fff', cursor: 'pointer' },
  stopBtn: { padding: '8 16', borderRadius: 4, background: '#a22', border: 'none', color: '#fff', cursor: 'pointer' },
};