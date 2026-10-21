import { Link } from '@tanstack/react-router'
import type { ImageContent } from '../types/image'
import { contentLines } from '../lib/image-contents'

export default function ImageContents({ contents, empty }: { contents: readonly ImageContent[]; empty: string }) {
  if (contents.length === 0) return <p className="text-xs text-slate-500">{empty}</p>
  return (
    <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]" data-testid="image-contents">
      {contentLines(contents).map((line) => (
        <li key={line.dependency} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-xs">
          <Link to="/studio/dependencies/$name" params={{ name: line.dependency }} className="font-mono text-sky-300 hover:underline">{line.dependency}</Link>
          {!line.installed && <span className="rounded border border-[var(--bark-600)] px-1 text-[10px] text-slate-400">in the base</span>}
          <span className="text-slate-400">because of {line.why}</span>
        </li>
      ))}
    </ul>
  )
}
