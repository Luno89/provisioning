import { describe, expect, it } from 'vitest'
import { dependencyForm, dependencyOf, installLines, usedByLines } from './dependency-forms'

describe('a dependency in the form', () => {
  it('round-trips through the form, each package once, empty parts left out', () => {
    const dependency = {
      name: 'pdf-tools',
      summary: 'PDF tools.',
      provides: ['pdftotext', 'pdfinfo'],
      needs: ['python'],
      install: [{ via: 'dnf' as const, packages: ['poppler-utils'] }, { via: 'script' as const, run: 'echo done' }],
      onDebian: [{ via: 'apt' as const, packages: ['poppler-utils'] }],
    }
    expect(dependencyOf(dependencyForm(dependency))).toEqual(dependency)

    const form = { ...dependencyForm({ name: ' tickets ' }), summary: ' Tickets. ', provides: 'tickets-mcp, tickets-mcp', install: { packages: { dnf: '', apt: '', pip: '', npm: 'tickets-mcp  tickets-mcp' }, script: '  ' } }
    expect(dependencyOf(form)).toEqual({ name: 'tickets', summary: 'Tickets.', provides: ['tickets-mcp'], install: [{ via: 'npm', packages: ['tickets-mcp'] }] })
  })

  it('says how it installs and who needs it in plain lines', () => {
    expect(installLines([{ via: 'npm', packages: ['a', 'b'] }, { via: 'script', run: 'make install' }])).toEqual(['npm a b', 'script: make install'])
    expect(usedByLines({ usedBy: { tools: ['fetch_pdf'], servers: ['tickets'], dependencies: ['koala-e2e'], steps: ['Run Browser Tests'], trees: [{ id: 't1', name: 'Web portal' }] } }))
      .toEqual(['the tool fetch_pdf', 'the MCP server tickets', 'the dependency koala-e2e', 'the step Run Browser Tests, in every agent whose procedure runs it', 'the workspace of the tree Web portal'])
  })

  it('shows a script that writes a file as the file it writes, readable', () => {
    const written = btoa('#!/bin/sh\necho hi\n')
    expect(installLines([{ via: 'script', run: `echo ${written} | base64 -d > /usr/local/bin/hi && chmod 755 /usr/local/bin/hi` }]))
      .toEqual(['script: writes /usr/local/bin/hi, then chmod 755 /usr/local/bin/hi:\n#!/bin/sh\necho hi'])
  })
})
