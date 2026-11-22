import type { InteractionPath } from '../api'

const INTERACTION = /^\/oidc\/interaction\/[A-Za-z0-9_-]+$/

const isInteraction = (path: string): path is InteractionPath => INTERACTION.test(path)

export const resumePathFrom = (search: string): InteractionPath | undefined => {
  const resume = new URLSearchParams(search).get('resume')
  return resume && isInteraction(resume) ? resume : undefined
}
