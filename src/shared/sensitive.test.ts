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
    // 4111 1111 1111 1111 is Luhn-valid; order numbers usually are not.
    expect(detectSensitiveKinds('卡号 4111111111111111')).toContain('bankCard')
    expect(detectSensitiveKinds('电话 13800138000')).toContain('phone')
  })

  it('stays quiet for ordinary prose and short numbers', () => {
    expect(detectSensitiveKinds('这家店 2024 年营业额 1234 元')).toEqual([])
    expect(detectSensitiveKinds('sk-short')).toEqual([])
    expect(detectSensitiveKinds('')).toEqual([])
  })

  it('flags tokens and assignments the basic patterns used to miss', () => {
    expect(detectSensitiveKinds('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij')).toContain('cloudKey')
    expect(detectSensitiveKinds('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456')).toContain('cloudKey')
    expect(detectSensitiveKinds('github_pat_11ABCDEFG0123456789_abcdefghijklmnop')).toContain('cloudKey')
    expect(detectSensitiveKinds('password = hunter2hunter2')).toContain('apiKey')
  })

  it('stops treating a random 19-digit id as a card number', () => {
    expect(detectSensitiveKinds('订单号 1234567890123456789')).toEqual([])
  })

  it('reports every kind once and builds a readable warning', () => {
    const kinds = detectSensitiveKinds('sk-abcdefghijklmnop1234 电话 13800138000')
    expect(kinds).toEqual(['apiKey', 'phone'])
    expect(sensitiveWarning(kinds)).toContain('API Key')
    expect(sensitiveWarning(kinds)).toContain('再次点击确认发送')
    expect(sensitiveWarning([])).toBe('')
  })
})
