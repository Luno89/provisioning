import { describe, expect, expectTypeOf, it } from 'vitest'
import { type ProcedureSummary, checkProcedureOnServer, deleteProcedure, getProcedure, getTrackRecords, listProcedures, saveProcedure } from './procedures'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { ProcedureSummary as BackendSummary } from '../../../../../backend/src/engine/services/ProcedureService'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend((site) => { mountEngine(site) })
await backend.signIn()

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads a procedure summary as the backend describes one', () => {
    expectTypeOf<Wire<BackendSummary>>().toExtend<ProcedureSummary>()
  })
})

describe('the Studio\'s procedures, as the browser asks for them', () => {
  it('lists the built-in procedures, none unreadable', async () => {
    const listed = await listProcedures()
    expect(listed.unreadable).toEqual([])
    expect(listed.procedures).toEqual(arrayWith([objectWith({ id: anyOf(String), name: anyOf(String), mine: false, ofBuiltIn: true })]))
  })

  it('reads a built-in procedure as not the person\'s, and answers 404 for one that does not exist', async () => {
    const [first] = (await listProcedures()).procedures
    expect(await getProcedure(first!.id)).toEqual({ procedure: objectWith({ id: first!.id }), mine: false })
    await expect(getProcedure('no-such-procedure')).rejects.toMatchObject({ response: { status: 404, data: { error: 'There is no procedure with that id' } } })
  })

  it('checks a built-in procedure on the server and finds no error in it', async () => {
    const [first] = (await listProcedures()).procedures
    const problems = await checkProcedureOnServer((await getProcedure(first!.id)).procedure)
    expect(problems.filter((problem) => problem.severity === 'error')).toEqual([])
  })

  it('checks a procedure with no steps on the server and names what is wrong', async () => {
    const [first] = (await listProcedures()).procedures
    const { procedure } = await getProcedure(first!.id)
    expect(await checkProcedureOnServer({ ...procedure, nodes: [] })).toEqual(arrayWith([objectWith({ severity: 'error', message: anyOf(String) })]))
  })

  it('saves the person\'s own copy of a procedure, which then reads as theirs, and deletes it', async () => {
    const [first] = (await listProcedures()).procedures
    const { procedure } = await getProcedure(first!.id)
    const outcome = await saveProcedure({ ...procedure, describe: 'My own copy' })
    expect(outcome).toEqual({ saved: true, procedure: objectWith({ id: first!.id, describe: 'My own copy' }), problems: anyOf(Array) })
    expect(await getProcedure(first!.id)).toEqual({ procedure: objectWith({ describe: 'My own copy' }), mine: true })
    await deleteProcedure(first!.id)
    expect((await getProcedure(first!.id)).mine).toBe(false)
    await expect(deleteProcedure(first!.id)).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no copy of that procedure to delete' } } })
  })

  it('answers a procedure that does not check clean with its problems instead of saving it', async () => {
    const [first] = (await listProcedures()).procedures
    const { procedure } = await getProcedure(first!.id)
    const outcome = await saveProcedure({ ...procedure, nodes: [] })
    expect(outcome).toEqual({ saved: false, problems: arrayWith([anyOf(Object)]) })
    expect((await getProcedure(first!.id)).mine).toBe(false)
  })

  it('reads a procedure\'s track record as empty before it has run', async () => {
    const [first] = (await listProcedures()).procedures
    expect(await getTrackRecords(first!.id)).toEqual([])
  })
})
