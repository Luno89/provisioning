import { describe, expect, it } from 'vitest'
import type { KoalaInstallView } from '@koala/engine-core/koala-install'
import { installShown } from './koala-install'

const install = (over: Partial<KoalaInstallView> = {}): KoalaInstallView => ({ id: 'i1', machineId: 'desk', state: 'installing', stage: 'koala', title: 'Putting Koala on this machine', at: '2026-11-18T10:00:00Z', ...over })
const desk = { id: 'desk', online: true }

describe('what a machine\'s row says of Koala being put on it', () => {
  it('says the stage it is at and what it waits on', () => {
    expect(installShown(install({ line: 'waiting for job/instance-seed-1 runs' }), desk)).toEqual({ kind: 'working', title: 'Putting Koala on this machine', line: 'waiting for job/instance-seed-1 runs' })
  })

  it('says it is being asked, or that it is asked once it connects when offline', () => {
    const { stage: _stage, title: _title, ...asked } = install({ state: 'asked' })
    expect(installShown(asked, desk)).toEqual({ kind: 'working', title: 'Asking it to put Koala on itself' })
    expect(installShown(asked, { id: 'desk', online: false })).toEqual({ kind: 'working', title: 'Koala is put on it once it connects' })
  })

  it('says where it stopped and why', () => {
    expect(installShown(install({ state: 'failed', why: 'no room' }), desk)).toEqual({ kind: 'failed', said: 'Koala could not be put here at Putting Koala on this machine', why: 'no room', retry: 'Try again' })
  })

  it('says a move is Koala moving here, where it stopped and why, and offers to move it here again', () => {
    expect(installShown(install({ move: true, stage: 'keys', title: 'Bringing your keys over', line: 'fetching the keys' }), desk)).toEqual({ kind: 'working', title: 'Bringing your keys over', line: 'fetching the keys' })
    const { stage: _stage, title: _title, ...asked } = install({ state: 'asked', move: true })
    expect(installShown(asked, desk)).toEqual({ kind: 'working', title: 'Asking it to move Koala onto itself' })
    expect(installShown(asked, { id: 'desk', online: false })).toEqual({ kind: 'working', title: 'Koala moves onto it once it connects' })
    expect(installShown(install({ move: true, state: 'failed', stage: 'koala', title: 'Bringing Koala over', why: 'the pool copy\'s data could not be read' }), desk)).toEqual({ kind: 'failed', said: 'Moving Koala here stopped at Bringing Koala over', why: 'the pool copy\'s data could not be read', retry: 'Move here' })
    const { title: _untitled, ...bare } = install({ move: true, state: 'installing' })
    expect(installShown(bare, desk)).toEqual({ kind: 'working', title: 'Moving Koala here' })
  })

  it('says nothing once Koala is up, nor of another machine\'s install', () => {
    expect(installShown(install({ state: 'ready' }), desk)).toBeUndefined()
    expect(installShown(install({ machineId: 'laptop' }), desk)).toBeUndefined()
    expect(installShown(undefined, desk)).toBeUndefined()
  })
})
