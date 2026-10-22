import { Box, Brain, FileText, FlaskConical, Inbox, Info, ListChecks, Network, Play, Settings2, Share2, Wrench, type LucideIcon } from 'lucide-react'

export type AgentFileId =
  | 'overview' | 'prompt' | 'procedure' | 'tools' | 'hand-offs' | 'workspace' | 'settings'
  | 'memories' | 'checks' | 'coverage' | 'changes' | 'try'

export const AGENT_FILES: readonly { id: AgentFileId; title: string; icon: LucideIcon; startsGroup?: boolean }[] = [
  { id: 'overview', title: 'Overview', icon: Info },
  { id: 'prompt', title: 'Prompt', icon: FileText },
  { id: 'procedure', title: 'Procedure', icon: Network },
  { id: 'tools', title: 'Tools', icon: Wrench },
  { id: 'hand-offs', title: 'Hand-offs', icon: Share2 },
  { id: 'workspace', title: 'Workspace', icon: Box },
  { id: 'settings', title: 'Settings', icon: Settings2 },
  { id: 'memories', title: 'Memories', icon: Brain, startsGroup: true },
  { id: 'checks', title: 'Checks', icon: FlaskConical },
  { id: 'coverage', title: 'Coverage', icon: ListChecks },
  { id: 'changes', title: 'Proposed changes', icon: Inbox },
  { id: 'try', title: 'Try it', icon: Play, startsGroup: true },
]

export const isAgentFile = (value: string | undefined): value is AgentFileId => AGENT_FILES.some((file) => file.id === value)
