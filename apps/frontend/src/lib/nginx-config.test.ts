import { describe, it, expect } from 'vitest'
import { insertServerBlock } from './nginx-config'

const BLOCK = 'server {\n    listen 80;\n}'

describe('inserting a server block', () => {
  it('puts it inside the http block, not after it', () => {
    const config = 'events {}\nhttp {\n    server {\n        listen 8080;\n    }\n}'
    const result = insertServerBlock(config, BLOCK)
    const httpEnd = result.lastIndexOf('}')
    expect(result.indexOf('listen 80;')).toBeLessThan(httpEnd)
  })

  it('keeps what was already there', () => {
    const config = 'http {\n    server { listen 8080; }\n}'
    const result = insertServerBlock(config, BLOCK)
    expect(result).toContain('listen 8080;')
    expect(result).toContain('listen 80;')
  })

  it('appends when there is no http block to insert into', () => {
    const result = insertServerBlock('# empty', BLOCK)
    expect(result).toContain('listen 80;')
  })

  it('appends when the config is empty', () => {
    expect(insertServerBlock('', BLOCK)).toContain('listen 80;')
  })

  it('is repeatable — a second route does not displace the first', () => {
    const config = 'events {}\nhttp {\n}'
    const once = insertServerBlock(config, 'server { listen 81; }')
    const twice = insertServerBlock(once, 'server { listen 82; }')
    expect(twice).toContain('listen 81;')
    expect(twice).toContain('listen 82;')
    expect(twice.indexOf('listen 82;')).toBeLessThan(twice.lastIndexOf('}'))
  })
})
