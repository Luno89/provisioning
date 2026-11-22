import { describe, expect, it } from 'vitest'
import { QueryClient, QueryObserver, type QueryObserverResult } from '@tanstack/react-query'
import { heardChange } from './heard-change'

describe('a change the page hears from root', () => {
  it('reads again when the change comes while the first load is still on its way, so the page shows what the change made', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let firstAnswer: (value: string) => void = () => undefined
    let asked = 0
    const observer = new QueryObserver<string>(client, {
      queryKey: ['machines'],
      queryFn: () => { asked += 1; return asked === 1 ? new Promise<string>((resolve) => { firstAnswer = resolve }) : Promise.resolve('after the change') },
    })
    const shown = new Promise<string>((done, failed) => {
      const unsubscribe = observer.subscribe((result: QueryObserverResult<string>) => {
        if (result.fetchStatus !== 'idle' || result.status === 'pending') return
        unsubscribe()
        if (result.data === 'after the change') done(result.data)
        else failed(new Error(`the page settled on "${String(result.data)}" after ${asked} answer(s), not on what the change made`))
      })
    })
    expect(asked).toBe(1)
    const heard = heardChange(client, { queryKey: ['machines'] })
    firstAnswer('before the change')
    await heard
    if (client.isFetching() === 0 && observer.getCurrentResult().status === 'pending') throw new Error('the page holds no answer and asks for none after hearing the change')
    expect(await shown).toBe('after the change')
    expect(asked).toBe(2)
  })
})
