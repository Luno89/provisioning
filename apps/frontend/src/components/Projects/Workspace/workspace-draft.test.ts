import { describe, expect, it } from 'vitest'
import { draftOf, fileOf, isEdited, newOnMain } from './workspace-draft'

const MANAGERS = ['dnf', 'apt', 'pip', 'npm']

describe('editing a workspace file', () => {
  it('round-trips a file through the form unchanged', () => {
    const file = { packages: { pip: ['cowsay', 'requests'], dnf: ['jq'] }, script: 'echo hi', languages: ['python'], env: [{ name: 'SHOP', value: 'demo' }] }
    expect(fileOf(draftOf(file, MANAGERS))).toEqual({ packages: { dnf: ['jq'], pip: ['cowsay', 'requests'] }, script: 'echo hi', languages: ['python'], env: [{ name: 'SHOP', value: 'demo' }] })
  })

  it('reads packages split by spaces or commas, once each, and drops what is left empty', () => {
    const draft = { ...draftOf(undefined, MANAGERS), packages: { dnf: ' jq,  ripgrep jq ', apt: '', pip: '', npm: '' }, script: '   ', env: [{ name: ' ', value: 'x' }, { name: ' MODE ', value: 'dev' }] }
    expect(fileOf(draft)).toEqual({ packages: { dnf: ['jq', 'ripgrep'] }, env: [{ name: 'MODE', value: 'dev' }] })
    expect(fileOf(draftOf(undefined, MANAGERS))).toEqual({})
  })

  it('knows when the form says something other than the file on main', () => {
    const file = { packages: { pip: ['cowsay'] } }
    const draft = draftOf(file, MANAGERS)
    expect(isEdited(draft, file, MANAGERS)).toBe(false)
    expect(isEdited({ ...draft, packages: { ...draft.packages, pip: 'cowsay, ' } }, file, MANAGERS)).toBe(false)
    expect(isEdited({ ...draft, languages: ['go'] }, file, MANAGERS)).toBe(true)
  })

  it('marks the lines main has that the published workspace does not', () => {
    const published = [{ what: 'dnf ripgrep', from: 'tool:count_lines' }]
    const composed = [...published, { what: 'pip cowsay', from: 'project' }]
    expect([...newOnMain(composed, published)]).toEqual([1])
    expect(newOnMain(composed, undefined).size).toBe(0)
  })
})
