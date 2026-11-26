import { describe, expect, it } from 'vitest'

import { detectSensitiveKinds, sensitiveWarning } from './sensitive'

describe('sensitive content detection', () => {
  it('flags credentials by prefix', () => {
    expect(detectSensitiveKinds('key: sk-abcdefghijklmnop1234')).toContain('apiKey')
    expect(detectSensitiveKinds('-----BEGIN RSA PRIVATE KEY-----')).toContain('privateKey')
    expect(detectSensitiveKinds('AKIAIOSFODNN7EXAMPLE')).toContain('cloudKey')
    expect(detectSensitiveKinds('ghp_abcdefghijklmnopqrstuvwxyz0123')).toContain('cloudKey')
  })

  it('flags identity, bank and phone numbers', () => {
    expect(detectSensitiveKinds('身份证 110101199003075512')).toContain('identityCard')
    expect(detectSensitiveKinds('卡号 6222021234567890123')).toContain('bankCard')
    expect(detectSensitiveKinds('电话 13800138000')).toContain('phone')
  })

  it('stays quiet for ordinary prose and short numbers', () => {
    expect(detectSensitiveKinds('这家店 2024 年营业额 1234 元')).toEqual([])
    expect(detectSensitiveKinds('sk-short')).toEqual([])
    expect(detectSensitiveKinds('')).toEqual([])
  })

  it('reports every kind once and builds a readable warning', () => {
    const kinds = detectSensitiveKinds('sk-abcdefghijklmnop1234 电话 13800138000')
    expect(kinds).toEqual(['apiKey', 'phone'])
    expect(sensitiveWarning(kinds)).toContain('API Key')
    expect(sensitiveWarning(kinds)).toContain('再次点击确认发送')
    expect(sensitiveWarning([])).toBe('')
  })
})
