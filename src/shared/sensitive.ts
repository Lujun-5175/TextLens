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
  { kind: 'cloudKey', pattern: /(?:^|[^A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})/u },
  { kind: 'identityCard', pattern: /(?:^|[^0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/u },
  { kind: 'bankCard', pattern: /(?:^|[^0-9])[0-9]{16,19}(?![0-9])/u },
  { kind: 'phone', pattern: /(?:^|[^0-9])1[3-9][0-9]{9}(?![0-9])/u }
]

/** Kinds present in `text`, in a stable order, without duplicates. */
export function detectSensitiveKinds(text: string): SensitiveKind[] {
  if (!text) return []
  const found: SensitiveKind[] = []
  for (const rule of RULES) {
    if (rule.pattern.test(text) && !found.includes(rule.kind)) {
      found.push(rule.kind)
    }
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
