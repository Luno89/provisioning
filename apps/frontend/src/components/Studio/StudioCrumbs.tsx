import { Fragment } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

export interface Crumb {
  label: string
  to?: string | undefined
  params?: Record<string, string> | undefined
}

export default function StudioCrumbs({ trail }: { trail: readonly Crumb[] }) {
  return (
    <nav aria-label="Where you are" className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
      {trail.map((crumb, index) => (
        <Fragment key={`${crumb.label}-${index}`}>
          {index > 0 && <ChevronRight size={12} className="text-slate-600" />}
          {crumb.to && index < trail.length - 1
            ? <Link to={crumb.to} params={crumb.params ?? {}} className="hover:text-slate-200 hover:underline">{crumb.label}</Link>
            : <span aria-current={index === trail.length - 1 ? 'page' : undefined} className={index === trail.length - 1 ? 'text-slate-200' : ''}>{crumb.label}</span>}
        </Fragment>
      ))}
    </nav>
  )
}
