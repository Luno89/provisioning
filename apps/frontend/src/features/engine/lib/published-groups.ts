import { GROUP_KIND, type GroupDefinition, type PlacedNode, type Procedure } from '@koala/agent-engine/procedure'

const PUBLISHED = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)@(\d+)$/
const DRAFT = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)$/

export interface PublishedName {
  extension: string
  name: string
  version: number
}

export function publishedName(groupId: string): PublishedName | undefined {
  const match = PUBLISHED.exec(groupId)
  return match ? { extension: match[1]!, name: match[2]!, version: Number(match[3]) } : undefined
}

export function draftOf(groupId: string): { extension: string; name: string } | undefined {
  const match = DRAFT.exec(groupId)
  return match ? { extension: match[1]!, name: match[2]! } : undefined
}

export function operationName(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '')
}

function pointing(procedure: Procedure, from: string, to: string): Procedure {
  const repoint = (node: PlacedNode): PlacedNode => (node.kind === GROUP_KIND && node.group === from ? { ...node, group: to } : node)
  return {
    ...procedure,
    nodes: procedure.nodes.map(repoint),
    groups: procedure.groups.map((group) => ({ ...group, nodes: group.nodes.map(repoint) })),
  }
}

export function draftNewVersion(procedure: Procedure, published: GroupDefinition): { procedure: Procedure; draftId: string } | { refused: string } {
  const name = publishedName(published.id)
  if (!name) return { refused: `${published.title} is not a published operation` }
  const draftId = `${name.extension}.${name.name}`
  if (procedure.groups.some((group) => group.id === draftId)) return { refused: `a new version of ${published.title} is already being drafted here` }
  const copy = structuredClone({ ...published, id: draftId })
  const repointed = pointing(procedure, published.id, draftId)
  return { procedure: { ...repointed, groups: [...repointed.groups, copy] }, draftId }
}

export function adoptPublished(procedure: Procedure, localId: string, publishedId: string): Procedure {
  const repointed = pointing(procedure, localId, publishedId)
  return { ...repointed, groups: repointed.groups.filter((group) => group.id !== localId) }
}
