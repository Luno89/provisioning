import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Users } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { getHubBoard, hubKeys } from '../api'
import type { HubBoardView } from '../types'
import { StoredFiles } from '../../files'
import { ProjectBoard } from '../../projects'
import { WorkSourceContext, type BoardChat } from '../../projects'
import HubChat from './HubChat'
import HubRepository from './HubRepository'
import HubStrip from './HubStrip'
import { HUB_BOARD_EVERY_MS, hubProjectOf, hubWorkSource } from '../lib/hub-work-source'
import SharedProjectPage from './SharedProjectPage'
import { youAre } from '../lib/hub-chat'

type Tab = 'board' | 'files' | 'people'

const TABS: { id: Tab; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'files', label: 'Files' },
  { id: 'people', label: 'People' },
]

function BoardTab({ view, me }: { view: HubBoardView; me: string }) {
  const client = useQueryClient()
  const base = useMemo(() => hubWorkSource(client, view), [client, view])
  const source = useMemo(() => ({
    ...base,
    chat: (chat: BoardChat) => base.hub ? <HubChat key={chat.kind === 'channel' ? 'channel' : chat.id} projectId={view.project.id} chat={chat} view={view} hub={base.hub} me={me} /> : null,
  }), [base, view, me])
  return (
    <WorkSourceContext.Provider value={source}>
      <div className="space-y-3">
        <HubStrip view={view} me={me} />
        <ProjectBoard projectId={hubProjectOf(view).id} chatOpen />
      </div>
    </WorkSourceContext.Provider>
  )
}

function FilesTab({ view }: { view: HubBoardView }) {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-1">
      <HubRepository projectId={view.project.id} />
      <StoredFiles scope={{ kind: 'hub', projectId: view.project.id }} rearranges={view.can.includes('change-files')} />
    </div>
  )
}

export default function HubProjectPage({ id, me, onLeft }: { id: string; me: string; onLeft?: (() => void) | undefined }) {
  const [tab, setTab] = useState<Tab>('board')
  const board = useQuery({
    queryKey: hubKeys.board(id),
    queryFn: () => getHubBoard(id),
    refetchInterval: HUB_BOARD_EVERY_MS,
    retry: false,
  })
  if (board.isPending) return <p className="p-6 text-[12px] text-slate-500"><Loader2 size={12} className="inline animate-spin" /> Opening the project…</p>
  if (board.isError) return <p className="p-6 text-[12px] text-red-300">{errorMessage(board.error)}</p>
  const view = board.data

  return (
    <div className="space-y-3 p-4" data-testid="shared-project">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100"><Users size={16} className="text-[var(--leaf)]" /> {view.project.name}</h1>
        <p className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{youAre(view.role)}</p>
        <div role="tablist" aria-label="Project" className="flex items-center gap-1 text-[12px]">
          {TABS.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} onClick={() => setTab(entry.id)} className={`rounded-md px-2 py-1 ${tab === entry.id ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {entry.label}
            </button>
          ))}
        </div>
      </header>
      {tab === 'board' && <BoardTab view={view} me={me} />}
      {tab === 'files' && <FilesTab view={view} />}
      {tab === 'people' && <SharedProjectPage id={id} me={me} onLeft={onLeft} embedded />}
    </div>
  )
}
