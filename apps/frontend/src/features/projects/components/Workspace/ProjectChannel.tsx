import { useQuery } from '@tanstack/react-query'
import ChatSurface from '../../../../components/ChatSurface.js'
import type { StoryAddress } from '../../../../components/Chat/ChatNotice.js'
import KoalaLoading from '../../../../shared/components/KoalaLoading.js'
import { getProjectChannel, projectChannelKeys } from '../../api/project-channel.js'
import { errorMessage } from '../../../../api/client.js'

export function ProjectChannel({ projectId, onOpenTree, onOpenStory }: {
  projectId: string
  onOpenStory?: ((story: StoryAddress) => void) | undefined
  onOpenTree?: ((treeId: string) => void) | undefined
}) {
  const opened = useQuery({ queryKey: projectChannelKeys.of(projectId), queryFn: () => getProjectChannel(projectId) })
  if (opened.isLoading) return <KoalaLoading label="Opening the channel…" />
  if (opened.isError || !opened.data) return <p className="p-4 text-[13px] text-rose-300">{errorMessage(opened.error)}</p>
  const { channel } = opened.data
  return (
    <div className="flex flex-col h-full min-h-0" data-testid="project-channel">
      <div className="flex-1 min-h-0">
        <ChatSurface key={channel.id} conversationId={channel.id} binding={{ projectId }} hideSidebar channel onOpenTree={onOpenTree} onOpenStory={onOpenStory} />
      </div>
    </div>
  )
}

export default ProjectChannel
