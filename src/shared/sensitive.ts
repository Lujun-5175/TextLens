/**
 * Heuristic detection of content the user probably did not mean to send to a
 * model provider. Deliberately conservative: a false positive costs one extra
 * click, a false negative sends a credential to a third party.
 *
 * Matching runs on the selected text only, never on saved settings or keys.
 */

export type SensitiveKind =
  | 'privateKey'
  | 'apiKey'
  | 'cloudKey'
  | 'identityCard'
  | 'bankCard'
  | 'phone'

const LABELS: Record<SensitiveKind, string> = {
  privateKey: '私钥',
  apiKey: 'API Key',
  cloudKey: '云服务密钥',
  identityCard: '身份证号',
  bankCard: '银行卡号',
  phone: '手机号'
}

interface Rule {
  kind: SensitiveKind
  pattern: RegExp
}

// No lookbehind: the result window targets WebKit builds that throw on it.
// Digit boundaries are expressed with an explicit non-digit prefix group.
const RULES: readonly Rule[] = [
  { kind: 'privateKey', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { kind: 'apiKey', pattern: /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/u },
  {
    kind: 'cloudKey',
    pattern: /(?:^|[^A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,})/u
  },
  // JWT: three base64url segments, the first two always start with eyJ.
  { kind: 'cloudKey', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u },
  { kind: 'cloudKey', pattern: /(?:^|[^A-Za-z])(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/iu },
  {
    kind: 'apiKey',
    pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/iu
  },
  { kind: 'identityCard', pattern: /(?:^|[^0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/u },
  { kind: 'bankCard', pattern: /(?:^|[^0-9])[0-9]{16,19}(?![0-9])/u },
  { kind: 'phone', pattern: /(?:^|[^0-9])1[3-9][0-9]{9}(?![0-9])/u }
]

/** Luhn check: 16-19 digit runs are usually order numbers, not cards. */
function passesLuhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

/** Kinds present in `text`, in a stable order, without duplicates. */
export function detectSensitiveKinds(text: string): SensitiveKind[] {
  if (!text) return []
  const found: SensitiveKind[] = []
  for (const rule of RULES) {
    if (found.includes(rule.kind)) continue
    if (!rule.pattern.test(text)) continue
    if (rule.kind === 'bankCard') {
      // Require a real card number so order ids stop triggering the warning,
      // and skip runs already reported as an identity number.
      const match = /(?:^|[^0-9])([0-9]{16,19})(?![0-9])/u.exec(text)
      if (!match || !passesLuhn(match[1]!) || found.includes('identityCard')) continue
    }
    found.push(rule.kind)
  }
  return found
}

export function sensitiveLabels(kinds: readonly SensitiveKind[]): string[] {
  return kinds.map((kind) => LABELS[kind])
}

/** One short sentence for a toolbar notice. */
export function sensitiveWarning(kinds: readonly SensitiveKind[]): string {
  const labels = sensitiveLabels(kinds)
  if (labels.length === 0) return ''
  return `选中内容可能包含${labels.join('、')}，再次点击确认发送`
}
