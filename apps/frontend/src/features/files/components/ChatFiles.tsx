import StoredFiles from './StoredFiles'

export default function ChatFiles({ conversationId }: { conversationId: string }) {
  return <StoredFiles scope={{ kind: 'conversation', conversationId }} title="Files in this chat" />
}
