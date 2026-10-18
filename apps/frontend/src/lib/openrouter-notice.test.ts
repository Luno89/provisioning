import { describe, expect, it } from 'vitest'
import { openRouterNoticeFrom, withoutOpenRouterNotice } from './openrouter-notice'

describe('coming back from OpenRouter', () => {
  it('says it connected, or what went wrong in the backend\'s words', () => {
    expect(openRouterNoticeFrom('?openrouterConnected=1')?.kind).toBe('success')
    expect(openRouterNoticeFrom(`?openrouterError=${encodeURIComponent('OpenRouter did not give Koala a key.')}`)).toEqual({ kind: 'error', message: 'OpenRouter did not give Koala a key.' })
    expect(openRouterNoticeFrom('?driveConnected=1')).toBeNull()
  })

  it('leaves the address without the notice, keeping anything else', () => {
    expect(withoutOpenRouterNotice('?openrouterConnected=1')).toBe('')
    expect(withoutOpenRouterNotice('?a=b&openrouterError=x')).toBe('?a=b')
  })
})
