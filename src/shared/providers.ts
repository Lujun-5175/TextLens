import type { ProviderProtocol } from './constants'

/**
 * Built-in provider presets.
 *
 * Creating a provider by hand asks for a protocol, a base URL and a model id
 * before the user can see any value. Each preset fills the two fields that are
 * easy to get wrong (protocol + endpoint) so only the API key is left to type.
 *
 * Endpoints are the vendors' documented OpenAI-compatible or native bases; the
 * app appends `/chat/completions`, `/responses`, `/messages` or `/models`.
 */
export interface ProviderPreset {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  /** Prefix that identifies this vendor's keys unambiguously. */
  keyPrefix?: string
  /** One line shown under the preset name. */
  hint: string
}

export const CUSTOM_PROVIDER_PRESET_ID = 'custom'

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openAiChat',
    baseUrl: 'https://api.deepseek.com/v1',
    hint: '官方 API，deepseek-flash 支持 none/low/high/max 思考档位'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openAiChat',
    baseUrl: 'https://api.openai.com/v1',
    hint: '官方 API，需要账户余额；也可改用 Responses 协议'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropicMessages',
    baseUrl: 'https://api.anthropic.com/v1',
    keyPrefix: 'sk-ant-',
    hint: 'Claude 系列，使用原生 Messages 协议'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    protocol: 'openAiChat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    hint: '国内服务商，常见开源模型'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openAiChat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPrefix: 'sk-or-',
    hint: '聚合多家模型，模型名带厂商前缀'
  },
  {
    id: CUSTOM_PROVIDER_PRESET_ID,
    name: '自定义',
    protocol: 'openAiChat',
    baseUrl: 'https://api.openai.com/v1',
    hint: '任何 OpenAI 兼容端点，地址需自己填写'
  }
]

export function providerPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}

/**
 * Recognize the vendor from a key prefix.
 *
 * Only prefixes that cannot belong to another vendor are listed: both DeepSeek
 * and OpenAI issue `sk-…` keys, so guessing there would mislead the user.
 */
export function detectProviderPreset(apiKey: string): ProviderPreset | null {
  const key = apiKey.trim()
  if (!key) return null
  return (
    PROVIDER_PRESETS.find(
      (preset) => preset.keyPrefix !== undefined && key.startsWith(preset.keyPrefix)
    ) ?? null
  )
}
