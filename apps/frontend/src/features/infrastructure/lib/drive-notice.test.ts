import { describe, it, expect } from 'vitest'
import { driveNoticeFrom } from './drive-notice'

describe('the notice after a Google Drive redirect', () => {
  it('says nothing when the user simply navigated here', () => {
    expect(driveNoticeFrom('')).toBeNull()
    expect(driveNoticeFrom('?tab=accounts')).toBeNull()
  })

  it('confirms a successful connection', () => {
    expect(driveNoticeFrom('?driveConnected=1')).toEqual({
      kind: 'success', message: 'Google Drive connected.',
    })
  })

  it('names the two env vars when the server has no Google credentials', () => {
    const notice = driveNoticeFrom('?driveError=missing_client_id')
    expect(notice?.kind).toBe('error')
    expect(notice?.message).toContain('GOOGLE_CLIENT_ID')
    expect(notice?.message).toContain('apps/backend/.env')
  })

  it('tells the user how to recover when Google withheld a refresh token', () => {
    expect(driveNoticeFrom('?driveError=no_refresh_token')?.message)
      .toContain('myaccount.google.com/permissions')
  })

  it('decodes an arbitrary error rather than showing percent-encoding', () => {
    expect(driveNoticeFrom('?driveError=token%20exchange%20failed')?.message)
      .toBe('Connection failed: token exchange failed')
  })
})
