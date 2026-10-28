import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Users } from 'lucide-react'
import { hubElsewhere, hubKeys } from '../api'
import { safeHref } from '../../../shared/lib/safe-href'

export default function SharedProjectsLink({ className, active }: { className: string; active: boolean }) {
  const navigate = useNavigate()
  const elsewhere = useQuery({ queryKey: [...hubKeys.all, 'elsewhere'], queryFn: hubElsewhere, staleTime: Infinity })
  const inner = <><Users size={16} /><span className="flex-1 text-left">Shared projects</span></>
  if (elsewhere.isPending) return null
  if (elsewhere.data) return <a href={safeHref(`${elsewhere.data}&next=${encodeURIComponent('/shared')}`)} className={className}>{inner}</a>
  return <button type="button" aria-current={active ? 'page' : undefined} onClick={() => void navigate({ to: '/shared' })} className={className}>{inner}</button>
}
