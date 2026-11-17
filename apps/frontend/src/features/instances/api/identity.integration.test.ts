import { describe, expect, it } from 'vitest'
import { getMyInstance } from './identity'
import { startBackend } from '../../../test/backend/site'

const backend = await startBackend(() => undefined)

describe('where a person\'s work is, asked of a backend that does not say', () => {
  it('a missing identity route is an error, not "no instance"', async () => {
    await backend.signIn()
    await expect(getMyInstance()).rejects.toMatchObject({ response: { status: 404 } })
  })
})
