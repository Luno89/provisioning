import { useParams } from '@tanstack/react-router'
import ProcedureEditor from './ProcedureEditor'

export default function ProcedurePage() {
  const { procedureId } = useParams({ strict: false }) as { procedureId: string }
  return <ProcedureEditor procedureId={procedureId} />
}
