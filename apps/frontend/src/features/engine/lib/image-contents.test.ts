import { describe, expect, it } from 'vitest'
import { contentLines, whyText } from './image-contents'

describe('what is in an image, and why', () => {
  it('says each reason in plain words', () => {
    expect(['tool:json_query', 'server:playwright', 'step:Run Browser Tests', 'dependency:koala-e2e', 'language:python', 'agent:judge', 'project', 'something-new'].map(whyText)).toEqual([
      'the tool json_query', 'the MCP server playwright', 'the step Run Browser Tests', 'koala-e2e, which needs it', 'the language python', 'the agent judge', 'the project\'s .koala/workspace.json', 'something-new',
    ])
  })

  it('puts every reason for one dependency on its line', () => {
    expect(contentLines([{ dependency: 'playwright', why: ['dependency:koala-e2e', 'tool:browse'], installed: true }]))
      .toEqual([{ dependency: 'playwright', why: 'koala-e2e, which needs it; the tool browse', installed: true }])
  })
})
