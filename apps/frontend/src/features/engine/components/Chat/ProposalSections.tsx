import type { ProposalPart, ProposalSection } from '@koala/harness-types'

function Part({ part }: { part: ProposalPart }) {
  if (part.kind === 'text') return <p className="whitespace-pre-wrap text-slate-300">{part.text}</p>
  if (part.kind === 'code') {
    return (
      <div className="flex flex-col gap-0.5">
        {part.label && <span className="text-[11px] text-slate-500">{part.label}</span>}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] text-slate-200"><code>{part.code}</code></pre>
      </div>
    )
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
      {part.fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-slate-500">{field.label}</dt>
          <dd className={`min-w-0 break-all ${field.code ? 'font-mono text-[11px] text-slate-200' : 'text-slate-300'}`}>{field.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Parts({ parts }: { parts: ProposalPart[] }) {
  return <div className="flex flex-col gap-1.5">{parts.map((part, index) => <Part key={index} part={part} />)}</div>
}

export default function ProposalSections({ sections }: { sections: ProposalSection[] }) {
  return (
    <div className="flex flex-col gap-3">
      {sections.map((section, index) => section.folded ? (
        <details key={section.title ?? index} className="group">
          <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-200">
            <span className="text-[11px] font-semibold uppercase tracking-wider">{section.title}</span>
            <span className="ml-2 text-slate-500">{section.folded}</span>
          </summary>
          <div className="mt-2 pl-3"><Parts parts={section.parts} /></div>
        </details>
      ) : (
        <section key={section.title ?? index} className="flex flex-col gap-1">
          {section.title && <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{section.title}</h4>}
          <Parts parts={section.parts} />
        </section>
      ))}
    </div>
  )
}
