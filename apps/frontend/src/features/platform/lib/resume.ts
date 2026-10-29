const INTERACTION = /^\/oidc\/interaction\/[A-Za-z0-9_-]+$/

export const resumePathFrom = (search: string): string | undefined => {
  const resume = new URLSearchParams(search).get('resume')
  return resume && INTERACTION.test(resume) ? resume : undefined
}
