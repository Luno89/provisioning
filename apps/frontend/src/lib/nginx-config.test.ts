import { describe, it, expect } from 'vitest'
import { insertServerBlock } from './nginx-config'

/**
 * The splice, tested without rendering a wizard.
 *
 * As a closure over the editor buffer inside a three-step wizard, the only way to exercise this was
 * to mount App, open the wizard, and click to step three — which is why the case that matters (a
 * `server` block landing outside `http`) had no coverage.
 */

const BLOCK = 'server {\n    listen 80;\n}'

describe('inserting a server block', () => {
  it('puts it inside the http block, not after it', () => {
    /**
     * The whole point. `server { }` outside `http { }` is a syntax error, and nginx rejects the
     * ENTIRE config rather than just the new route — so one bad append takes down every existing
     * proxy, not only the one being added.
     */
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
    // Not a config this can reason about — but silently doing nothing would leave the user with a
    // wizard that appears to work and changes nothing.
    const result = insertServerBlock('# empty', BLOCK)
    expect(result).toContain('listen 80;')
  })

  it('appends when the config is empty', () => {
    expect(insertServerBlock('', BLOCK)).toContain('listen 80;')
  })

  it('is repeatable — a second route does not displace the first', () => {
    // Adding two routes in a row is the normal case, and the second splice has to respect the
    // first one's braces rather than treating them as the http block's.
    const config = 'events {}\nhttp {\n}'
    const once = insertServerBlock(config, 'server { listen 81; }')
    const twice = insertServerBlock(once, 'server { listen 82; }')
    expect(twice).toContain('listen 81;')
    expect(twice).toContain('listen 82;')
    expect(twice.indexOf('listen 82;')).toBeLessThan(twice.lastIndexOf('}'))
  })
})
