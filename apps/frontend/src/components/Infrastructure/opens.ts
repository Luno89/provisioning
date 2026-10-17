import type { RunningItem } from '../../api/running'

export function hashFor(opens: RunningItem['opens']): string {
  switch (opens.kind) {
    case 'chat': return `#/chat/${opens.id ?? ''}`
    case 'tree': return `#/projects/tree/${opens.id ?? ''}`
    case 'project': return `#/projects/project/${opens.id ?? ''}`
    case 'checks': return '#/evals'
    case 'temporal': return '#/temporal'
  }
}
