import { describe, expect, it } from 'vitest'
import { safeHref } from './safe-href'

describe('a link the server sent, before the page opens it', () => {
  it('opens web addresses, paths and hashes as they came', () => {
    expect(safeHref('https://shop-luno.nowrinkles.app/web')).toBe('https://shop-luno.nowrinkles.app/web')
    expect(safeHref('http://127.0.0.1:30320')).toBe('http://127.0.0.1:30320')
    expect(safeHref('/api/artifacts/a1')).toBe('/api/artifacts/a1')
    expect(safeHref('#/projects/p1')).toBe('#/projects/p1')
    expect(safeHref('//cdn.example.com/a')).toBe('//cdn.example.com/a')
  })

  it('opens nothing that runs script or carries a document of its own, however it is written', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/1']) {
      expect(safeHref(bad), bad).toBeUndefined()
    }
    expect(safeHref('')).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
    expect(safeHref('http://[bad')).toBeUndefined()
  })
})
