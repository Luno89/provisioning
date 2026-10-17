import { Navigate, useParams } from '@tanstack/react-router'

export default function MonitoringDetailRedirect() {
  const { kind, id } = useParams({ strict: false }) as { kind: string; id: string }
  return <Navigate to="/infrastructure/$kind/$id" params={{ kind, id }} replace />
}
