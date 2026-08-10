import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Model output, rendered as the markdown it actually is.
 *
 * ── WHAT THIS REPLACES ──
 * Every reply was rendered with `whitespace-pre-wrap`, so the model's most structured output came
 * out as its own syntax. Measured on a real reply about the Temporal SDK: a comparison of five
 * fields arrived as a markdown table and displayed as rows of pipe characters, with `##` and `**`
 * left as literal text. The better the model formatted its answer, the worse it read.
 *
 * It also affects output the harness writes itself — a leaf-failure notice showed its own asterisks
 * — which is what finally made this worth doing.
 *
 * ── SAFETY ──
 * This renders untrusted text: model output, and repository content the model quotes. Raw HTML is
 * NOT enabled (no `rehype-raw`), so a reply containing a `<script>` or an `onerror` attribute is
 * shown as text rather than parsed. react-markdown's default URL handling drops `javascript:` and
 * similar schemes, which is what stops a crafted link in a reply becoming a click target.
 *
 * ── WIDTH ──
 * Tables and code blocks scroll inside their own container. A wide table is exactly what arrived in
 * the reply that motivated this, and letting it push the page sideways would trade unreadable
 * pipes for an unreadable layout.
 */
export default function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div className={`kmd ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children: c }) => <h1 className="text-base font-bold text-slate-100 mt-4 mb-2 first:mt-0">{c}</h1>,
          h2: ({ children: c }) => <h2 className="text-[15px] font-bold text-slate-100 mt-4 mb-2 first:mt-0">{c}</h2>,
          h3: ({ children: c }) => <h3 className="text-sm font-bold text-slate-200 mt-3 mb-1.5 first:mt-0">{c}</h3>,
          p: ({ children: c }) => <p className="mb-2 last:mb-0 leading-relaxed">{c}</p>,
          ul: ({ children: c }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{c}</ul>,
          ol: ({ children: c }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{c}</ol>,
          li: ({ children: c }) => <li className="leading-relaxed">{c}</li>,
          strong: ({ children: c }) => <strong className="font-semibold text-slate-100">{c}</strong>,
          em: ({ children: c }) => <em className="italic">{c}</em>,
          blockquote: ({ children: c }) => (
            <blockquote className="border-l-2 border-[var(--bark-600)] pl-3 my-2 text-slate-400">{c}</blockquote>
          ),
          /**
           * `inline` was removed from the props in react-markdown v10, so a fenced block is
           * detected by the newline the parser leaves in its content rather than by a flag.
           */
          code: ({ children: c, className: cls }) => {
            const text = String(c ?? '');
            const fenced = text.includes('\n') || Boolean(cls);
            if (!fenced) {
              return <code className="px-1 py-0.5 rounded bg-[var(--bark-800)] text-[0.9em] text-emerald-300/90">{c}</code>;
            }
            return (
              <pre className="my-2 rounded-lg bg-[var(--bark-900)] border border-[var(--bark-600)] p-3 overflow-x-auto">
                <code className="text-[12px] text-slate-300 whitespace-pre">{text.replace(/\n$/, '')}</code>
              </pre>
            );
          },
          // Already wrapped by `code` above; a second <pre> would nest and double the padding.
          pre: ({ children: c }) => <>{c}</>,
          table: ({ children: c }) => (
            <div className="my-2 overflow-x-auto">
              <table className="text-[12px] border-collapse">{c}</table>
            </div>
          ),
          th: ({ children: c }) => (
            <th className="border border-[var(--bark-600)] px-2 py-1 text-left font-semibold text-slate-200 bg-[var(--bark-800)]">{c}</th>
          ),
          td: ({ children: c }) => <td className="border border-[var(--bark-600)] px-2 py-1 align-top">{c}</td>,
          a: ({ children: c, href }) => (
            // Opened in a new tab with noreferrer: these are links the MODEL chose, and a reply
            // should not be able to navigate the app away or hand the destination a referrer.
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-blue-400 hover:underline break-words">{c}</a>
          ),
          hr: () => <hr className="my-3 border-[var(--bark-600)]" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
