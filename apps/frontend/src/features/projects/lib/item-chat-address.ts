export interface ChatPlace {
  kind?: string | undefined
  treeId?: string | undefined
  leafId?: string | undefined
  branchId?: string | undefined
}

export function itemChatAddress(conversation: ChatPlace, leaves: readonly { id: string; branchId: string }[]): string | undefined {
  if (conversation.kind !== 'item' || !conversation.treeId) return undefined
  if (conversation.leafId) {
    const leaf = leaves.find((entry) => entry.id === conversation.leafId)
    return leaf ? `#/projects/tree/${conversation.treeId}/${leaf.branchId}/${leaf.id}` : undefined
  }
  return conversation.branchId ? `#/projects/tree/${conversation.treeId}/${conversation.branchId}` : undefined
}
