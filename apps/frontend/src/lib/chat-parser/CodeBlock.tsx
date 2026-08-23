import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export default function CodeBlock({
  language,
  value,
}: {
  language?: string | undefined;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code', err);
    }
  };

  const isDiff = language === 'diff' || (!language && (value.startsWith('---') || value.startsWith('+++') || value.startsWith('diff --git')));

  const renderCodeLines = () => {
    if (!isDiff) {
      return <code className="text-[12px] text-slate-200 font-mono leading-relaxed block whitespace-pre">{value}</code>;
    }

    const lines = value.split('\n');
    return (
      <code className="text-[12px] font-mono leading-relaxed block whitespace-pre">
        {lines.map((line, idx) => {
          let lineCls = 'text-slate-300';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            lineCls = 'text-emerald-400 bg-emerald-950/30 px-1 rounded-sm block';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            lineCls = 'text-red-400 bg-red-950/30 px-1 rounded-sm block';
          } else if (line.startsWith('@@')) {
            lineCls = 'text-cyan-400 font-bold block';
          }
          return (
            <span key={idx} className={lineCls}>
              {line}
              {'\n'}
            </span>
          );
        })}
      </code>
    );
  };

  const langLabel = (language || (isDiff ? 'diff' : 'text')).toUpperCase();

  return (
    <div className="my-3 rounded-xl bg-[var(--bark-950,#0f1117)] border border-[var(--bark-700,#2a2e3d)] overflow-hidden shadow-md">
      {/* Code Header Bar */}
      <div className="px-3.5 py-1.5 bg-[var(--bark-850,#161922)] border-b border-[var(--bark-700,#2a2e3d)] flex items-center justify-between text-[11px] text-slate-400 font-mono">
        <span className="font-bold text-slate-300 tracking-wider">{langLabel}</span>
        <button
          onClick={copyToClipboard}
          className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-[var(--bark-700,#2a2e3d)] text-slate-300 hover:text-white transition-colors cursor-pointer"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          <span>{copied ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>

      {/* Code Content Container */}
      <pre className="p-3.5 overflow-x-auto m-0">
        {renderCodeLines()}
      </pre>
    </div>
  );
}
