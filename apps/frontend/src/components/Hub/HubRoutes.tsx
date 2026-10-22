import { useNavigate, useParams } from '@tanstack/react-router'
import { useShellStore } from '../../stores/shell'
import SharedProjects from './SharedProjects'
import HubProjectPage from './HubProjectPage'
import JoinPage from './JoinPage'

export function SharedProjectsRoute() {
  return <SharedProjects />
}

export function SharedProjectRoute() {
  const { id } = useParams({ strict: false }) as { id?: string }
  const me = useShellStore((s) => s.user?.id) ?? ''
  const navigate = useNavigate()
  return <HubProjectPage key={id} id={id ?? ''} me={me} onLeft={() => void navigate({ to: '/shared' })} />
}

export function HubJoinRoute() {
  const { token } = useParams({ strict: false }) as { token?: string }
  const me = useShellStore((s) => s.user?.email) ?? ''
  const navigate = useNavigate()
  return <JoinPage token={token ?? ''} me={me} onJoined={(id) => void navigate({ to: '/shared/$id', params: { id } })} />
}
