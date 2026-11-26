import { describe, expect, it } from 'vitest'

import {
  CUSTOM_PROVIDER_PRESET_ID,
  PROVIDER_PRESETS,
  detectProviderPreset,
  providerPresetById
} from './providers'

describe('provider presets', () => {
  it('keeps ids unique and every base URL a usable https endpoint', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0)
      expect(preset.hint.length).toBeGreaterThan(0)
      expect(new URL(preset.baseUrl).protocol).toBe('https:')
    }
  })

  it('never guesses a vendor from an sk- key shared by several vendors', () => {
    // DeepSeek and OpenAI both issue sk- keys, so detection must stay silent.
    expect(detectProviderPreset('sk-0123456789abcdef')).toBeNull()
    expect(detectProviderPreset('   ')).toBeNull()
    expect(detectProviderPreset('')).toBeNull()
  })

  it('detects vendors whose key prefix is unambiguous', () => {
    expect(detectProviderPreset('sk-ant-api03-xyz')?.id).toBe('anthropic')
    expect(detectProviderPreset('sk-or-v1-xyz')?.id).toBe('openrouter')
    expect(detectProviderPreset('  sk-ant-padded  ')?.id).toBe('anthropic')
  })

  it('keeps the custom preset last and editable', () => {
    const last = PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!
    expect(last.id).toBe(CUSTOM_PROVIDER_PRESET_ID)
    expect(providerPresetById(CUSTOM_PROVIDER_PRESET_ID)).toBe(last)
    expect(providerPresetById('nope')).toBeUndefined()
  })
})
