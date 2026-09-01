import React, { useRef, useEffect } from 'react';
import { Send, Square, Sliders, Cpu, Sparkles } from 'lucide-react';

export interface PersonaPackOption {
  id: string;
  name: string;
  label: string;
  desc: string;
}

export interface ChatComposerProps {
  input: string;
  onChangeInput: (text: string) => void;
  onSend: (text?: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  activePack?: PersonaPackOption | undefined;
  /**
   * One control, not three. The pack menu, the tool count and the drawer button were separate
   * entries that all led to the same editor, so which one you pressed changed nothing.
   */
  onOpenPersonaDrawer: () => void;
  toolCount?: number;
  /** What this conversation runs on; the label reads as inherited when nothing is pinned. */
  modelLabel?: string;
  onOpenModelDrawer?: (() => void) | undefined;
  placeholder?: string;
  className?: string;
}

export function ChatComposer({
  input,
  onChangeInput,
  onSend,
  onStop,
  isStreaming,
  activePack,
  onOpenPersonaDrawer,
  toolCount,
  modelLabel,
  onOpenModelDrawer,
  placeholder,
  className = '',
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChangeInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  useEffect(() => {
    if (!input && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend(input);
    }
  };

  return (
    <div
      className={`w-full bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] focus-within:border-emerald-500/70 rounded-lg p-2.5 shadow-sm transition-colors flex flex-col gap-2 font-sans ${className}`}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={handleTextareaChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? (activePack ? `Message ${activePack.name}...` : 'Message…')}
        className="w-full bg-transparent border-0 resize-none px-1.5 py-1 text-xs text-slate-100 placeholder-slate-500 focus:outline-none max-h-52 overflow-y-auto leading-relaxed font-sans"
      />

      <div className="flex items-center justify-between pt-1 border-t border-[var(--bark-800,#1b2620)] px-0.5 select-none">
        <div className="flex items-center gap-1.5 relative">
          <button
            type="button"
            onClick={onOpenPersonaDrawer}
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-xs text-slate-300 hover:text-white transition-colors cursor-pointer"
            title="Pick the pack, and edit its directives and tools"
          >
            <Sparkles size={11} className="text-emerald-400" />
            <span className="font-medium">{activePack?.name ?? 'Loading…'}</span>
            {toolCount !== undefined && (
              <span className="text-[11px] text-slate-500">· {toolCount} tools</span>
            )}
            <Sliders size={11} className="text-slate-500" />
          </button>

          {onOpenModelDrawer && (
            <button
              type="button"
              onClick={onOpenModelDrawer}
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-xs text-slate-300 hover:text-white transition-colors cursor-pointer max-w-[240px]"
              title="Which model answers in this conversation"
            >
              <Cpu size={11} className="text-emerald-400" />
              <span className="truncate font-mono text-[11px]">{modelLabel ?? 'Model'}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-[11px] text-slate-500 font-sans">
            ↵ send · shift+↵ newline
          </span>

          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer flex items-center gap-1 text-xs font-medium"
              title="Stop generation"
            >
              <Square size={11} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send message"
              onClick={() => onSend(input)}
              disabled={!input.trim()}
              className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white transition-colors cursor-pointer disabled:cursor-not-allowed flex items-center gap-1 text-xs font-medium"
              title="Send message (Enter)"
            >
              <Send size={11} />
              <span>Send</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ChatComposer;
