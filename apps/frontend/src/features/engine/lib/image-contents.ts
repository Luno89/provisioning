import type { ImageContent } from '../types/image'

export function whyText(reason: string): string {
  const at = reason.indexOf(':')
  const kind = at < 0 ? reason : reason.slice(0, at)
  const name = at < 0 ? '' : reason.slice(at + 1)
  if (kind === 'tool') return `the tool ${name}`
  if (kind === 'server') return `the MCP server ${name}`
  if (kind === 'step') return `the step ${name}`
  if (kind === 'dependency') return `${name}, which needs it`
  if (kind === 'language') return `the language ${name}`
  if (kind === 'agent') return `the agent ${name}`
  if (kind === 'project') return 'the project\'s .koala/workspace.json'
  return reason
}

export function contentLines(contents: readonly ImageContent[]): { dependency: string; why: string; installed: boolean }[] {
  return contents.map((content) => ({ dependency: content.dependency, installed: content.installed, why: content.why.map(whyText).join('; ') }))
}

const STATE_TEXT: Record<string, string> = {
  ready: 'Built and ready',
  building: 'Being built now',
  failed: 'Its last build failed',
  unbuilt: 'Not built yet; it is built the first time it runs',
}

export const imageStateText = (state: string): string => STATE_TEXT[state] ?? state
