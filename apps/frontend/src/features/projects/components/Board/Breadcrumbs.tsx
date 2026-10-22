import { ChevronRight } from 'lucide-react'

export interface Crumb {
  label: string
  onOpen?: (() => void) | undefined
}

export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[12px]">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <li key={`${index}-${crumb.label}`} className="flex items-center gap-1 min-w-0">
              {index > 0 && <ChevronRight size={12} className="text-slate-600 shrink-0" aria-hidden="true" />}
              {last || !crumb.onOpen ? (
                <span aria-current={last ? 'page' : undefined} className={`break-words ${last ? 'text-slate-200 font-medium' : 'text-slate-500'}`}>{crumb.label}</span>
              ) : (
                <button type="button" onClick={crumb.onOpen} className="text-emerald-300 hover:underline cursor-pointer break-words text-left">{crumb.label}</button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default Breadcrumbs
