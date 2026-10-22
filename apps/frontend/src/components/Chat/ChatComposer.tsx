import React, { useRef, useEffect, useState } from 'react';
import { Send, Square, Sliders, Cpu, Sparkles, Paperclip, X, MessageSquare, Zap } from 'lucide-react';
import { goesToKoala } from '../../features/projects';
import { pickedFiles, type PickedFile } from '../../features/files';
import { DropTarget } from '../../features/files';

export interface PersonaPackOption {
  id: string;
  name: string;
  label: string;
  desc: string;
}

export interface ComposerAttachment {
  key: string;
  name: string;
  state: 'uploading' | 'ready' | 'failed';
  share: number;
  why?: string | undefined;
}

export interface ChatComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  activePack?: PersonaPackOption | undefined;
  /**
   * One control, not three. The pack menu, the tool count and the drawer button were separate
   * entries that all led to the same editor, so which one you pressed changed nothing.
   * Omitted entirely (not just unclicked) when there is no pack config surface to open —
   * a scope with no pack picker shows no button rather than a permanent "Loading…".
   */
  onOpenPersonaDrawer?: (() => void) | undefined;
  toolCount?: number;
  mcpCount?: number | undefined;
  /** What this conversation runs on; the label reads as inherited when nothing is pinned. */
  modelLabel?: string;
  onOpenModelDrawer?: (() => void) | undefined;
  placeholder?: string;
  className?: string;
  attachments?: ComposerAttachment[] | undefined;
  onRemoveAttachment?: ((key: string) => void) | undefined;
  onAttach?: ((picked: PickedFile[]) => void) | undefined;
  channelAsk?: { on: boolean; onToggle: () => void } | undefined;
  autoMode?: { on: boolean; switching: boolean; onToggle: () => void } | undefined;
}

export function ChatComposer({
  onSend,
  onStop,
  isStreaming,
  activePack,
  onOpenPersonaDrawer,
  toolCount,
  mcpCount,
  modelLabel,
  onOpenModelDrawer,
  placeholder,
  className = '',
  attachments,
  onRemoveAttachment,
  onAttach,
  channelAsk,
  autoMode,
}: ChatComposerProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const readyCount = (attachments ?? []).filter((attachment) => attachment.state === 'ready').length;
  const uploading = (attachments ?? []).some((attachment) => attachment.state === 'uploading');

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
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

  const send = () => {
    if (isStreaming || uploading) return;
    const text = input.trim();
    if (!text && readyCount === 0) return;
    setInput('');
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const body = (
    <div
      className={`w-full bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] focus-within:border-emerald-500/70 rounded-lg p-2.5 shadow-sm transition-colors flex flex-col gap-2 font-sans ${className}`}
      onPaste={(event) => {
        if (!onAttach || !event.clipboardData.files.length) return;
        event.preventDefault();
        onAttach(pickedFiles(event.clipboardData.files));
      }}
    >
      {attachments && attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-0.5" data-testid="composer-attachments">
          {attachments.map((a) => (
            <span
              key={a.key}
              className={`flex items-center gap-1 pl-2 pr-1 py-0.5 rounded border text-[11px] max-w-[260px] ${a.state === 'failed' ? 'border-red-500/50 text-red-200' : 'bg-[var(--bark-800,#1b2620)] border-[var(--bark-700,#24332b)] text-slate-300'}`}
              title={a.state === 'failed' ? `Not attached: ${a.why ?? 'the upload failed'}` : a.name}
            >
              <Paperclip size={10} className={a.state === 'failed' ? 'text-red-300 shrink-0' : 'text-emerald-400 shrink-0'} />
              <span className="truncate">{a.name}</span>
              {a.state === 'uploading' && <span className="shrink-0 text-[10px] text-sky-300">{Math.round(a.share * 100)}%</span>}
              {a.state === 'failed' && <span className="shrink-0 text-[10px]">failed</span>}
              {onRemoveAttachment && (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.key)}
                  className="shrink-0 text-slate-500 hover:text-white"
                  aria-label={`Remove ${a.name}`}
                >
                  <X size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={handleTextareaChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? (activePack ? `Message ${activePack.name}...` : 'Message…')}
        className="w-full bg-transparent border-0 resize-none px-1.5 py-1 text-xs text-slate-100 placeholder-slate-500 focus:outline-none max-h-52 overflow-y-auto leading-relaxed font-sans"
      />

      <div className="flex flex-wrap items-center justify-between gap-y-1 pt-1 border-t border-[var(--bark-800,#1b2620)] px-0.5 select-none">
        <div className="flex flex-wrap items-center gap-1.5 relative min-w-0">
          {onOpenPersonaDrawer && (
            <button
              type="button"
              onClick={onOpenPersonaDrawer}
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-xs text-slate-300 hover:text-white transition-colors cursor-pointer"
              title="Pick who answers in this conversation, and see its directives and tools"
            >
              <Sparkles size={11} className="text-emerald-400" />
              <span className="font-medium">{activePack?.name ?? 'Loading…'}</span>
              {toolCount !== undefined && (
                <span className="text-[11px] text-slate-500">· {toolCount} tools</span>
              )}
              {mcpCount !== undefined && mcpCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-500/40 text-[10px] text-emerald-300 font-mono font-medium">
                  {mcpCount} MCP
                </span>
              )}
              <Sliders size={11} className="text-slate-500" />
            </button>
          )}

          {channelAsk && (
            <button
              type="button"
              onClick={channelAsk.onToggle}
              aria-pressed={channelAsk.on}
              className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors cursor-pointer ${
                channelAsk.on
                  ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-200'
                  : 'bg-[var(--bark-950,#090d0b)] border-[var(--bark-700,#24332b)] text-slate-400 hover:text-white'
              }`}
              title={channelAsk.on ? 'Every message you send here goes to Koala. Click to only post to the channel.' : 'Messages are posted to the channel; only ones with @koala go to Koala. Click to ask Koala every time.'}
            >
              <Sparkles size={11} className={channelAsk.on ? 'text-emerald-400' : 'text-slate-500'} />
              <span className="font-medium">{channelAsk.on ? 'Asking Koala' : 'Ask Koala: off'}</span>
            </button>
          )}

          {autoMode && (
            <button
              type="button"
              onClick={autoMode.onToggle}
              disabled={autoMode.switching}
              aria-pressed={autoMode.on}
              className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors cursor-pointer disabled:opacity-60 ${
                autoMode.on
                  ? 'bg-amber-950/70 border-amber-500/60 text-amber-200'
                  : 'bg-[var(--bark-950,#090d0b)] border-[var(--bark-700,#24332b)] text-slate-400 hover:text-white'
              }`}
              title={autoMode.on
                ? 'Nothing this chat runs asks before it runs, any command or tool, including the agents it hands work to. Click to be asked again.'
                : 'Every command or tool that needs your say-so asks first. Click to let everything this chat runs go ahead without asking.'}
            >
              <Zap size={11} className={autoMode.on ? 'text-amber-400' : 'text-slate-500'} />
              <span className="font-medium">{autoMode.on ? 'Auto mode: on' : 'Auto mode: off'}</span>
            </button>
          )}

          {onOpenModelDrawer && (
            <button
              type="button"
              onClick={onOpenModelDrawer}
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-xs text-slate-300 hover:text-white transition-colors cursor-pointer max-w-[240px] min-w-0"
              title="Which model answers in this conversation"
            >
              <Cpu size={11} className="text-emerald-400" />
              <span className="truncate font-mono text-[11px]">{modelLabel ?? 'Model'}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {onAttach && (
            <>
              <button
                type="button"
                onClick={() => picker.current?.click()}
                aria-label="Attach files"
                title="Attach files: they are stored on the file server and Koala is told where"
                className="p-1 rounded text-slate-400 hover:text-white hover:bg-[var(--bark-800,#1b2620)] cursor-pointer"
              >
                <Paperclip size={12} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                aria-label="Files to attach"
                onChange={(event) => { const picked = pickedFiles(event.target.files); event.target.value = ''; if (picked.length) onAttach(picked); }}
              />
            </>
          )}
          <span className="hidden sm:inline text-[11px] text-slate-500 font-sans whitespace-nowrap">
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
              onClick={send}
              disabled={uploading || (!input.trim() && readyCount === 0)}
              className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white transition-colors cursor-pointer disabled:cursor-not-allowed flex items-center gap-1 text-xs font-medium"
              title={uploading ? 'Waiting for the attachments to finish uploading' : 'Send message (Enter)'}
            >
              {channelAsk && !goesToKoala(input, channelAsk.on) ? <MessageSquare size={11} /> : <Send size={11} />}
              <span>{channelAsk ? (goesToKoala(input, channelAsk.on) ? 'Ask Koala' : 'Post') : 'Send'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return onAttach ? <DropTarget label="Drop to attach" onFiles={onAttach}>{body}</DropTarget> : body;
}

export default ChatComposer;
