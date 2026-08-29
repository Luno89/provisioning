import { describe, it, expect } from 'vitest'
import { getSupportedVolumes, getFallbackSize, getVolumeDescription } from './app-volumes'

describe('which volumes an app has', () => {
  it('gives a Helm deployment volumes a native one does not', () => {
    expect(getSupportedVolumes('odoo', 'helm')).toEqual(['db', 'web'])
    expect(getSupportedVolumes('odoo', 'native')).toEqual(['db'])
  })

  it('gives an app with no persistence nothing to resize', () => {
    expect(getSupportedVolumes('prometheus', 'native')).toEqual([])
  })

  it('gives a media app its three volumes regardless of strategy', () => {
    for (const strategy of ['helm', 'native']) {
      expect(getSupportedVolumes('audiobookshelf', strategy)).toEqual(['library', 'metadata', 'config'])
    }
  })

  it('returns a list for an unknown app type rather than throwing', () => {
    expect(Array.isArray(getSupportedVolumes('something-new', 'native'))).toBe(true)
  })
})

describe('default sizes', () => {
  it('sizes a media library larger than a config volume', () => {
    const library = parseInt(getFallbackSize('library'), 10)
    const config = parseInt(getFallbackSize('config'), 10)
    expect(library).toBeGreaterThan(config)
  })

  it('always returns a valid Kubernetes quantity', () => {
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
