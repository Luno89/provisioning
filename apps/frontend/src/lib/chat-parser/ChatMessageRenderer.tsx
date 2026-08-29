import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Terminal } from 'lucide-react';
import { ChatParser } from './chat-parser.js';
import CodeBlock from './CodeBlock.js';
import AlertBlock, { type AlertType } from './AlertBlock.js';
import ThoughtAccordion from './ThoughtAccordion.js';

export default function ChatMessageRenderer({
  content,
  reasoning,
  className = '',
}: {
  content: string;
  reasoning?: string | undefined;
  className?: string;
}) {
  const parsed = ChatParser.parse(content);
  const allThoughts = [...(reasoning ? [reasoning] : []), ...parsed.thoughts];

  return (
    <div className={`chat-message-renderer space-y-2 ${className}`}>
      {(allThoughts.length > 0 || parsed.isThinking) && (
        <ThoughtAccordion thoughts={allThoughts} isThinking={parsed.isThinking} />
      )}

      {parsed.toolCalls.length > 0 && (
        <div className="space-y-1 my-2">
          {parsed.toolCalls.map((tc, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border border-slate-700/60 rounded-lg text-[11px] font-mono text-slate-300"
            >
              <Terminal size={12} className="text-[var(--leaf,#10b981)]" />
              <span className="font-semibold text-emerald-400">{tc.name}</span>
              <span className="text-slate-500 truncate max-w-xs">{tc.args}</span>
            </div>
          ))}
        </div>
      )}

      {parsed.cleanContent && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children: c }) => <h1 className="text-base font-bold text-slate-100 mt-4 mb-2 first:mt-0">{c}</h1>,
            h2: ({ children: c }) => <h2 className="text-[15px] font-bold text-slate-100 mt-3 mb-2 first:mt-0">{c}</h2>,
            h3: ({ children: c }) => <h3 className="text-sm font-bold text-slate-200 mt-3 mb-1.5 first:mt-0">{c}</h3>,
            p: ({ children: c }) => <p className="mb-2 last:mb-0 leading-relaxed text-slate-200">{c}</p>,
            ul: ({ children: c }) => <ul className="list-disc pl-5 mb-2 space-y-1 text-slate-200">{c}</ul>,
            ol: ({ children: c }) => <ol className="list-decimal pl-5 mb-2 space-y-1 text-slate-200">{c}</ol>,
            li: ({ children: c }) => <li className="leading-relaxed">{c}</li>,
            strong: ({ children: c }) => <strong className="font-semibold text-slate-100">{c}</strong>,
            em: ({ children: c }) => <em className="italic text-slate-300">{c}</em>,
            blockquote: ({ children: c }) => {
              const firstChild = Array.isArray(c) ? c[0] : c;
              const textContent = typeof firstChild === 'string' ? firstChild : '';
              const match = textContent.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);

              if (match && match[1]) {
                const alertType = match[1].toLowerCase() as AlertType;
                return <AlertBlock type={alertType}>{c}</AlertBlock>;
              }

              return (
                <blockquote className="border-l-2 border-slate-600 pl-3.5 my-2.5 text-slate-400 italic">
                  {c}
                </blockquote>
              );
            },
            code: ({ children: c, className: cls }) => {
              const text = String(c ?? '');
              const match = /language-(\w+)/.exec(cls || '');
              const lang = match ? match[1] : undefined;
              const isFenced = text.includes('\n') || Boolean(cls);

              if (!isFenced) {
                return (
                  <code className="px-1.5 py-0.5 rounded bg-[var(--bark-800,#1d212c)] text-[0.9em] text-emerald-300 font-mono border border-slate-700/40">
                    {c}
                  </code>
                );
              }

              return <CodeBlock language={lang} value={text.replace(/\n$/, '')} />;
            },
            pre: ({ children: c }) => <>{c}</>,
            table: ({ children: c }) => (
              <div className="my-3 overflow-x-auto rounded-lg border border-[var(--bark-700,#2a2e3d)]">
                <table className="min-w-full text-[12px] divide-y divide-[var(--bark-700,#2a2e3d)]">{c}</table>
              </div>
            ),
            thead: ({ children: c }) => <thead className="bg-[var(--bark-800,#1d212c)]">{c}</thead>,
            th: ({ children: c }) => (
              <th className="px-3 py-2 text-left font-bold text-slate-200 uppercase tracking-wider text-[10px]">
                {c}
              </th>
            ),
            td: ({ children: c }) => (
              <td className="px-3 py-2 text-slate-300 border-t border-[var(--bark-800,#1d212c)] align-top">
                {c}
              </td>
            ),
            a: ({ children: c, href }) => (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sky-400 hover:text-sky-300 hover:underline font-medium break-words"
              >
                {c}
              </a>
            ),
            hr: () => <hr className="my-4 border-slate-700/60" />,
          }}
        >
          {parsed.cleanContent}
        </ReactMarkdown>
      )}
    </div>
  );
}
