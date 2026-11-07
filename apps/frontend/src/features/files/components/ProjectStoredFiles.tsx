import StoredFiles from './StoredFiles'

export default function ProjectStoredFiles({ projectId, dir = '', title = 'Files', onOpen }: { projectId: string; dir?: string | undefined; title?: string | undefined; onOpen?: ((path: string) => void) | undefined }) {
  return <StoredFiles scope={{ kind: 'project', projectId }} dir={dir} title={title} onOpen={onOpen} />
}
