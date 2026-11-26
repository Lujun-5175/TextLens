import {
  MAX_CUSTOM_ACTIONS,
  MAX_ENABLED_ACTIONS,
  MAX_PROVIDER_MODELS,
  TEXT_PLACEHOLDER,
  isAiActionDefinition,
  isSearchActionDefinition,
  isValidTauriGlobalShortcut,
  publicSettingsSchema,
  settingsUpdateSchema,
  validateOpenAiBaseUrl,
  type ActionDefinition,
  type PublicProviderSettings,
  type PublicSettings,
  type SettingsUpdate
} from '../../shared'
import { isLucideIconName } from '../components/lucideIconRegistry'

export function sortAndNumberActions(actions: readonly ActionDefinition[]): ActionDefinition[] {
  return [...actions]
    .sort((left, right) => left.order - right.order)
    .map((action, index) => ({ ...action, order: index }))
}

export function moveActionToZone(
  actions: readonly ActionDefinition[],
  actionId: string,
  enabled: boolean,
  targetIndex: number
): ActionDefinition[] {
  const ordered = sortAndNumberActions(actions)
  const moving = ordered.find((action) => action.id === actionId)
  if (!moving) return ordered

  const enabledItems = ordered.filter((action) => action.enabled && action.id !== actionId)
  const disabledItems = ordered.filter((action) => !action.enabled && action.id !== actionId)
  const target = enabled ? enabledItems : disabledItems
  const index = Math.min(Math.max(0, targetIndex), target.length)
  target.splice(index, 0, { ...moving, enabled })

  return [...enabledItems, ...disabledItems].map((action, order) => ({ ...action, order }))
}

export function removeProviderFromSettings(
  settings: PublicSettings,
  providerId: PublicProviderSettings['id']
): PublicSettings {
  return {
    ...settings,
    providers: settings.providers.filter((provider) => provider.id !== providerId),
    actions: settings.actions.map((action) =>
      isAiActionDefinition(action) && action.providerId === providerId
        ? { ...action, providerId: '', modelId: '' }
        : action
    )
  }
}

export function removeProviderModelFromSettings(
  settings: PublicSettings,
  providerId: PublicProviderSettings['id'],
  modelId: string
): PublicSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            models: provider.models.filter((model) => model.id !== modelId)
          }
        : provider
    ),
    actions: settings.actions.map((action) =>
      isAiActionDefinition(action) &&
      action.providerId === providerId &&
      action.modelId === modelId
        ? { ...action, modelId: '' }
        : action
    )
  }
}

/** Actions bound to one provider+model, used to warn before the binding is broken. */
export function actionsBoundToModel(
  actions: readonly ActionDefinition[],
  providerId: string,
  modelId: string
): ActionDefinition[] {
  return actions.filter(
    (action) =>
      isAiActionDefinition(action) &&
      action.providerId === providerId &&
      action.modelId === modelId
  )
}

export function actionsUsingProvider(
  actions: readonly ActionDefinition[],
  providerId: string
): ActionDefinition[] {
  return actions.filter(
    (action) => isAiActionDefinition(action) && action.providerId === providerId
  )
}

export type SettingsFieldError =
  | 'translation'
  | 'captureShortcut'
  | 'actions'
  | 'filter'
  | `provider:${string}:baseUrl`
  | `provider:${string}:name`
  | `provider:${string}:models`
  | `captureRule:${number}`
  | `action:${string}`

const PROVIDER_NAME_MAX = 80
const MODEL_FIELD_MAX = 256
const CAPTURE_RULE_MAX = 512

/**
 * Best-effort mapping from a Zod issue path to the control that should get
 * focus. Zod's own English messages never reach the user; this only decides
 * where the generic Chinese message is shown.
 */
export function fieldForIssuePath(
  path: readonly PropertyKey[],
  providers: readonly Pick<PublicProviderSettings, 'id'>[],
  actions: readonly Pick<ActionDefinition, 'id'>[]
): SettingsFieldError | undefined {
  const [head, index, ...rest] = path
  if (head === 'translate') return 'translation'
  if (head === 'captureShortcut') return 'captureShortcut'
  if (head === 'actions') {
    if (typeof index !== 'number') return 'actions'
    const action = actions[index]
    return action ? `action:${action.id}` : 'actions'
  }
  if (head === 'filter') return 'filter'
  if (head === 'selectionCapture' && index === 'applications' && typeof rest[0] === 'number') {
    return `captureRule:${rest[0]}`
  }
  if (head === 'providers' && typeof index === 'number') {
    const provider = providers[index]
    if (!provider) return undefined
    const leaf = rest[0]
    if (leaf === 'baseUrl') return `provider:${provider.id}:baseUrl`
    if (leaf === 'name') return `provider:${provider.id}:name`
    return `provider:${provider.id}:models`
  }
  return undefined
}

export function buildSettingsUpdate(settings: PublicSettings):
  | { valid: true; value: SettingsUpdate }
  | { valid: false; message: string; field?: SettingsFieldError } {
  if (settings.translate.defaultLanguage === settings.translate.targetLanguage) {
    return { valid: false, field: 'translation', message: '默认语言和翻译语言不能相同' }
  }

  const captureShortcut = settings.captureShortcut.trim()
  if (!isValidTauriGlobalShortcut(captureShortcut)) {
    return {
      valid: false,
      field: 'captureShortcut',
      message: '捕获快捷键格式无效，请使用例如 CommandOrControl+Shift+S 的格式'
    }
  }
  if (settings.trigger.mode === 'shortcut' && captureShortcut === '') {
    return {
      valid: false,
      field: 'captureShortcut',
      message: '快捷键触发模式需要设置捕获快捷键'
    }
  }

  for (const provider of settings.providers) {
    const name = provider.name.trim()
    if (name === '') {
      return {
        valid: false,
        field: `provider:${provider.id}:name`,
        message: '服务商名称不能为空'
      }
    }
    if (name.length > PROVIDER_NAME_MAX) {
      return {
        valid: false,
        field: `provider:${provider.id}:name`,
        message: `服务商名称不能超过 ${PROVIDER_NAME_MAX} 个字符`
      }
    }
    const validation = validateOpenAiBaseUrl(provider.baseUrl.trim())
    if (!validation.valid) {
      return {
        valid: false,
        field: `provider:${provider.id}:baseUrl`,
        message: `“${name}”：${validation.reason}`
      }
    }
    if (provider.models.length > MAX_PROVIDER_MODELS) {
      return {
        valid: false,
        field: `provider:${provider.id}:models`,
        message: `“${name}”最多只能保留 ${MAX_PROVIDER_MODELS} 个模型，请先删除多余模型`
      }
    }
    const seenModels = new Set<string>()
    for (const model of provider.models) {
      const modelId = model.id.trim()
      const modelName = model.name.trim()
      if (modelId === '') {
        return {
          valid: false,
          field: `provider:${provider.id}:models`,
          message: `“${name}”中存在模型 ID 为空的项，请删除或补全`
        }
      }
      if (modelName === '') {
        return {
          valid: false,
          field: `provider:${provider.id}:models`,
          message: `“${name}”中的模型“${modelId}”缺少名称，请补全`
        }
      }
      if (modelId.length > MODEL_FIELD_MAX || modelName.length > MODEL_FIELD_MAX) {
        return {
          valid: false,
          field: `provider:${provider.id}:models`,
          message: `模型 ID 与名称不能超过 ${MODEL_FIELD_MAX} 个字符`
        }
      }
      if (seenModels.has(modelId)) {
        return {
          valid: false,
          field: `provider:${provider.id}:models`,
          message: `“${name}”中存在重复的模型 ID：${modelId}`
        }
      }
      seenModels.add(modelId)
    }
  }

  const seenCaptureRules = new Map<string, number>()
  for (const [index, rule] of settings.selectionCapture.applications.entries()) {
    const application = rule.application.trim()
    if (application === '') {
      return {
        valid: false,
        field: `captureRule:${index}`,
        message: `第 ${index + 1} 条程序规则不能为空，请填写程序名或删除该条规则`
      }
    }
    if (application.length > CAPTURE_RULE_MAX) {
      return {
        valid: false,
        field: `captureRule:${index}`,
        message: `第 ${index + 1} 条程序规则不能超过 ${CAPTURE_RULE_MAX} 个字符`
      }
    }
    const key = application.replaceAll('/', '\\').toLowerCase()
    const duplicateIndex = seenCaptureRules.get(key)
    if (duplicateIndex !== undefined) {
      return {
        valid: false,
        field: `captureRule:${index}`,
        message: `第 ${index + 1} 条程序规则与第 ${duplicateIndex + 1} 条重复`
      }
    }
    seenCaptureRules.set(key, index)
  }

  const oversizedFilterIndex = settings.filter.applications.findIndex(
    (application) => application.trim().length > CAPTURE_RULE_MAX
  )
  if (oversizedFilterIndex >= 0) {
    return {
      valid: false,
      field: 'filter',
      message: `应用过滤列表第 ${oversizedFilterIndex + 1} 项不能超过 ${CAPTURE_RULE_MAX} 个字符`
    }
  }

  const actions = sortAndNumberActions(settings.actions)
  const enabledCount = actions.filter((action) => action.enabled).length
  if (enabledCount < 1) {
    return { valid: false, field: 'actions', message: '至少需要启用一个工具栏动作' }
  }
  if (enabledCount > MAX_ENABLED_ACTIONS) {
    return {
      valid: false,
      field: 'actions',
      message: `最多只能启用 ${MAX_ENABLED_ACTIONS} 个动作`
    }
  }
  const customCount = actions.filter((action) => action.kind === 'custom').length
  if (customCount > MAX_CUSTOM_ACTIONS) {
    return {
      valid: false,
      field: 'actions',
      message: `最多只能创建 ${MAX_CUSTOM_ACTIONS} 个自定义动作`
    }
  }

  const providersById = new Map(settings.providers.map((provider) => [provider.id, provider]))
  for (const action of actions) {
    if (!isLucideIconName(action.icon)) {
      return {
        valid: false,
        field: `action:${action.id}`,
        message: `“${action.name}”使用了无效的 Lucide 图标`
      }
    }
    if (isSearchActionDefinition(action) && !action.searchEngineId) {
      return {
        valid: false,
        field: `action:${action.id}`,
        message: `“${action.name}”需要选择搜索引擎`
      }
    }
    if (!isAiActionDefinition(action)) continue
    if (!action.prompt.includes(TEXT_PLACEHOLDER)) {
      return {
        valid: false,
        field: `action:${action.id}`,
        message: `“${action.name}”的提示词必须包含 ${TEXT_PLACEHOLDER}`
      }
    }
    if (action.providerId) {
      const provider = providersById.get(action.providerId)
      if (!provider) {
        return {
          valid: false,
          field: `action:${action.id}`,
          message: `“${action.name}”引用了不存在的服务商`
        }
      }
      if (action.modelId && !provider.models.some((model) => model.id === action.modelId)) {
        return {
          valid: false,
          field: `action:${action.id}`,
          message: `“${action.name}”引用了不存在的模型`
        }
      }
    }
  }

  const candidate: SettingsUpdate = {
    enabled: settings.enabled,
    captureShortcut,
    locale: settings.locale,
    translate: settings.translate,
    toolbar: settings.toolbar,
    appearance: settings.appearance,
    result: settings.result,
    trigger: settings.trigger,
    application: settings.application,
    filter: settings.filter,
    selectionCapture: {
      defaultStrategy: settings.selectionCapture.defaultStrategy,
      applications: settings.selectionCapture.applications.map((rule) => ({
        application: rule.application.trim(),
        strategy: rule.strategy
      }))
    },
    providers: settings.providers.map(({ keyConfigured: _keyConfigured, ...provider }) => ({
      ...provider,
      baseUrl: provider.baseUrl.trim(),
      name: provider.name.trim(),
      models: provider.models.map((model) => ({
        id: model.id.trim(),
        name: model.name.trim(),
        thinkingLevels: model.thinkingLevels ?? [],
        thinkingCapability: model.thinkingCapability,
        thinkingEnabled: model.thinkingEnabled,
        thinkingDefault: model.thinkingDefault
      }))
    })),
    actions
  }

  const fullSettings = publicSettingsSchema.safeParse({
    ...settings,
    ...candidate,
    version: settings.version,
    providers: settings.providers.map((provider) => ({
      ...provider,
      baseUrl: provider.baseUrl.trim(),
      name: provider.name.trim(),
      models: provider.models.map((model) => ({
        id: model.id.trim(),
        name: model.name.trim(),
        thinkingLevels: model.thinkingLevels ?? [],
        thinkingCapability: model.thinkingCapability,
        thinkingEnabled: model.thinkingEnabled,
        thinkingDefault: model.thinkingDefault
      }))
    }))
  })
  if (!fullSettings.success) {
    // Zod messages are diagnostics, not user copy: keep them in the console
    // and show a Chinese message that points at the offending control.
    console.warn('[settings] 设置内容未通过结构化校验', fullSettings.error.issues)
    const issue = fullSettings.error.issues[0]
    return {
      valid: false,
      field: issue ? fieldForIssuePath(issue.path, settings.providers, actions) : undefined,
      message: '设置内容不符合保存要求，请检查标出的字段'
    }
  }
  const parsed = settingsUpdateSchema.safeParse(candidate)
  if (!parsed.success) {
    console.warn('[settings] 设置更新未通过结构化校验', parsed.error.issues)
    const issue = parsed.error.issues[0]
    return {
      valid: false,
      field: issue ? fieldForIssuePath(issue.path, settings.providers, actions) : undefined,
      message: '设置内容不符合保存要求，请检查标出的字段'
    }
  }
  return { valid: true, value: parsed.data }
}
