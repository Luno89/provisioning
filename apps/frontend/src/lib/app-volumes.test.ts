import { describe, it, expect } from 'vitest'
import { getSupportedVolumes, getFallbackSize, getVolumeDescription } from './app-volumes'

/**
 * The storage tab's rules, tested without rendering anything.
 *
 * As three closures inside `App.tsx` these could only be exercised by mounting a 2,858-line
 * component and clicking to a tab — which is why the Helm-versus-native difference, the part most
 * likely to be wrong, had no coverage at all.
 */

describe('which volumes an app has', () => {
  it('gives a Helm deployment volumes a native one does not', () => {
    // The Helm charts create a PVC for the web tier; the native manifests do not. Offering to
    // resize one that does not exist fails deep in kubectl with a confusing message.
    expect(getSupportedVolumes('odoo', 'helm')).toEqual(['db', 'web'])
    expect(getSupportedVolumes('odoo', 'native')).toEqual(['db'])
  })

  it('gives an app with no persistence nothing to resize', () => {
    // An empty list is what makes the tab say "no volumes" rather than showing an empty form.
    expect(getSupportedVolumes('prometheus', 'native')).toEqual([])
  })

  it('gives a media app its three volumes regardless of strategy', () => {
    for (const strategy of ['helm', 'native']) {
      expect(getSupportedVolumes('audiobookshelf', strategy)).toEqual(['library', 'metadata', 'config'])
    }
  })

  it('returns a list for an unknown app type rather than throwing', () => {
    // A new app type reaching this before the switch knows about it must not break the tab.
    expect(Array.isArray(getSupportedVolumes('something-new', 'native'))).toBe(true)
  })
})

describe('default sizes', () => {
  it('sizes a media library larger than a config volume', () => {
    // The reason there is a per-volume default at all rather than one number.
    const library = parseInt(getFallbackSize('library'), 10)
    const config = parseInt(getFallbackSize('config'), 10)
    expect(library).toBeGreaterThan(config)
  })

  it('always returns a valid Kubernetes quantity', () => {
    // It is written straight into a PVC spec; anything else fails the apply.
    for (const v of ['db', 'web', 'library', 'metadata', 'config', 'server', 'unknown-volume']) {
      expect(getFallbackSize(v), v).toMatch(/^\d+(Mi|Gi|Ti)$/)
    }
  })
})

describe('descriptions', () => {
  it('says what every known volume holds', () => {
    for (const v of ['db', 'web', 'library', 'metadata', 'config']) {
      expect(getVolumeDescription(v), v).toBeTruthy()
    }
  })
})
