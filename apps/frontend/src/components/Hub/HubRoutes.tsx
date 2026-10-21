import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useShellStore } from '../../stores/shell'
import SharedProjects from './SharedProjects'
import SharedProjectPage from './SharedProjectPage'
import JoinPage from './JoinPage'
import NewSharedProject from './NewSharedProject'

export function SharedProjectsRoute() {
  return <SharedProjects />
}

export function SharedProjectRoute() {
  const { id } = useParams({ strict: false }) as { id?: string }
  const me = useShellStore((s) => s.user?.id) ?? ''
  const navigate = useNavigate()
  return <SharedProjectPage key={id} id={id ?? ''} me={me} onLeft={() => void navigate({ to: '/shared' })} />
}

export function HubJoinRoute() {
  const { token } = useParams({ strict: false }) as { token?: string }
  const me = useShellStore((s) => s.user?.email) ?? ''
  const navigate = useNavigate()
  return <JoinPage token={token ?? ''} me={me} onJoined={(id) => void navigate({ to: '/shared/$id', params: { id } })} />
}

export function NewSharedProjectRoute() {
  const search = useSearch({ strict: false }) as { name?: string; project?: string; instance?: string }
  const navigate = useNavigate()
  const origin = search.project ? { projectId: search.project, ...(search.instance ? { instanceId: search.instance } : {}) } : undefined
  return <NewSharedProject name={search.name ?? ''} origin={origin} onMade={(id) => void navigate({ to: '/shared/$id', params: { id }, replace: true })} />
}
