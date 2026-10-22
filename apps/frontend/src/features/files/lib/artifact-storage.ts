import { ARTIFACT_LINK } from '../api/artifacts'

const DISMISSED = 'koala.minio-prompt.dismissed'

export const mentionsArtifacts = (text: string | undefined): boolean => Boolean(text && ARTIFACT_LINK.test(text))

export function promptDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED) === 'yes'
  } catch {
    return false
  }
}

export function dismissPrompt(): void {
  try {
    window.localStorage.setItem(DISMISSED, 'yes')
  } catch {
    return
  }
}
