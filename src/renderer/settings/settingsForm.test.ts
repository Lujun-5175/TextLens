import {
  DEFAULT_PROVIDER_ID,
  DEFAULT_PUBLIC_SETTINGS,
  MAX_ENABLED_ACTIONS,
  TEXT_PLACEHOLDER
} from '../../shared'
import {
  actionsBoundToModel,
  buildSettingsUpdate,
  fieldForIssuePath,
  moveActionToZone,
  removeProviderModelFromSettings,
  removeProviderFromSettings,
  sortAndNumberActions
} from './settingsForm'

describe('settings form helpers', () => {
  it('includes the selected search engine in ordinary settings updates', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      actions: DEFAULT_PUBLIC_SETTINGS.actions.map((action) =>
        action.kind === 'search' ? { ...action, searchEngineId: 'bing-china' as const } : action
      )
    })

    expect(result.valid).toBe(true)
    if (result.valid) {
      const search = result.value.actions?.find((action) => action.kind === 'search')
      expect(search && 'searchEngineId' in search ? search.searchEngineId : null).toBe('bing-china')
    }
  })

  it('includes the Windows close behavior in ordinary settings updates', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      application: { closeBehavior: 'quit' }
    })

    expect(result.valid).toBe(true)
    if (result.valid) expect(result.value.application).toEqual({ closeBehavior: 'quit' })
  })

  it('includes the appearance theme in ordinary settings updates', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      appearance: { theme: 'sage' }
    })

    expect(result.valid).toBe(true)
    if (result.valid) expect(result.value.appearance).toEqual({ theme: 'sage' })
  })

  it('includes per-application capture strategies in ordinary settings updates', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      selectionCapture: {
        defaultStrategy: 'selection-hook',
        applications: [{ application: 'reader.exe', strategy: 'clipboard' }]
      }
    })

    expect(result.valid).toBe(true)
    if (result.valid) expect(result.value.selectionCapture).toEqual({
      defaultStrategy: 'selection-hook',
      applications: [{ application: 'reader.exe', strategy: 'clipboard' }]
    })
  })

  it('rejects identical default and target translation languages', () => {
    expect(buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      translate: { defaultLanguage: 'zh-CN', targetLanguage: 'zh-CN' }
    })).toEqual({
      valid: false,
      field: 'translation',
      message: '默认语言和翻译语言不能相同'
    })
  })

  it('rejects shortcut names that Tauri cannot register', () => {
    expect(buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      captureShortcut: 'Ctrl+Return'
    })).toEqual({
      valid: false,
      field: 'captureShortcut',
      message: '捕获快捷键格式无效，请使用例如 CommandOrControl+Shift+S 的格式'
    })
  })

  it('requires a capture shortcut when trigger mode is shortcut', () => {
    expect(buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      trigger: { mode: 'shortcut' },
      captureShortcut: ''
    })).toEqual({
      valid: false,
      field: 'captureShortcut',
      message: '快捷键触发模式需要设置捕获快捷键'
    })
  })

  it('sorts actions and rewrites their order without mutating input', () => {
    const original = [
      { ...DEFAULT_PUBLIC_SETTINGS.actions[0]!, order: 4 },
      { ...DEFAULT_PUBLIC_SETTINGS.actions[1]!, order: 1 }
    ]
    const sorted = sortAndNumberActions(original)

    expect(sorted.map((action) => action.id)).toEqual(['explain', 'translate'])
    expect(sorted.map((action) => action.order)).toEqual([0, 1])
    expect(original[0]!.order).toBe(4)
  })

  it('rejects a custom prompt without the selection placeholder', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      actions: [
        ...DEFAULT_PUBLIC_SETTINGS.actions,
        {
          id: 'custom-test',
          name: '自定义',
          icon: 'sparkles',
          kind: 'custom',
          enabled: false,
          order: 9,
          prompt: '没有占位符',
          providerId: DEFAULT_PROVIDER_ID,
          modelId: '',
          thinkingMode: 'off' as const
        }
      ]
    })
    expect(result).toEqual({
      valid: false,
      field: 'action:custom-test',
      message: `“自定义”的提示词必须包含 ${TEXT_PLACEHOLDER}`
    })
  })

  it('accepts no more than the toolbar action limit', () => {
    const actions = Array.from({ length: MAX_ENABLED_ACTIONS }, (_, index) => ({
      id: `custom-${index}`,
      name: `动作 ${index}`,
      icon: 'sparkles',
      kind: 'custom' as const,
      enabled: true,
      order: index,
      prompt: `处理 ${TEXT_PLACEHOLDER}`,
      providerId: DEFAULT_PROVIDER_ID,
      modelId: '',
      thinkingMode: 'off' as const
    }))
    expect(buildSettingsUpdate({ ...DEFAULT_PUBLIC_SETTINGS, actions }).valid).toBe(true)
  })

  it('reorders within and across the enabled/disabled zones', () => {
    const moved = moveActionToZone(DEFAULT_PUBLIC_SETTINGS.actions, 'refine', true, 1)
    expect(moved.filter((action) => action.enabled).map((action) => action.id)).toEqual([
      'translate',
      'refine',
      'explain',
      'summary',
      'search',
      'copy',
      'ask-ai'
    ])
    expect(moved.find((action) => action.id === 'refine')?.enabled).toBe(true)
  })

  it('removes a provider and safely unbinds every AI action that used it', () => {
    const updated = removeProviderFromSettings(DEFAULT_PUBLIC_SETTINGS, DEFAULT_PROVIDER_ID)

    expect(updated.providers).toHaveLength(0)
    expect(
      updated.actions
        .filter((action) => 'providerId' in action)
        .every((action) => action.providerId === '' && action.modelId === '')
    ).toBe(true)
    expect(DEFAULT_PUBLIC_SETTINGS.providers).toHaveLength(1)
    expect(DEFAULT_PUBLIC_SETTINGS.actions[0]).toHaveProperty('providerId', DEFAULT_PROVIDER_ID)
  })

  it('removes a model and clears only actions bound to that provider and model', () => {
    const selectedModel = {
      id: 'model-selected',
      name: 'Selected model',
      thinkingLevels: [] as Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>
    }
    const otherModel = {
      id: 'model-other',
      name: 'Other model',
      thinkingLevels: [] as Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>
    }
    const configured = {
      ...DEFAULT_PUBLIC_SETTINGS,
      providers: DEFAULT_PUBLIC_SETTINGS.providers.map((provider) => ({
        ...provider,
        models: [selectedModel, otherModel]
      })),
      actions: DEFAULT_PUBLIC_SETTINGS.actions.map((action, index) =>
        'providerId' in action
          ? { ...action, modelId: index === 0 ? selectedModel.id : otherModel.id }
          : action
      )
    }

    const updated = removeProviderModelFromSettings(
      configured,
      DEFAULT_PROVIDER_ID,
      selectedModel.id
    )

    expect(updated.providers[0]?.models).toEqual([otherModel])
    expect(updated.actions[0]).toHaveProperty('modelId', '')
    expect(updated.actions[1]).toHaveProperty('modelId', otherModel.id)
    expect(configured.providers[0]?.models).toHaveLength(2)
  })

  it('lists the actions bound to one provider+model before deleting it', () => {
    const configured = {
      ...DEFAULT_PUBLIC_SETTINGS,
      actions: DEFAULT_PUBLIC_SETTINGS.actions.map((action) =>
        'providerId' in action && action.id === 'translate'
          ? { ...action, modelId: 'model-selected' }
          : action
      )
    }

    expect(
      actionsBoundToModel(configured.actions, DEFAULT_PROVIDER_ID, 'model-selected')
        .map((action) => action.name)
    ).toEqual(['翻译'])
    expect(actionsBoundToModel(configured.actions, DEFAULT_PROVIDER_ID, 'other')).toEqual([])
  })
})

describe('settings form validation messages', () => {
  it('reports an empty provider name in Chinese with the provider field', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      providers: DEFAULT_PUBLIC_SETTINGS.providers.map((provider) => ({
        ...provider,
        name: '   '
      }))
    })

    expect(result).toEqual({
      valid: false,
      field: `provider:${DEFAULT_PROVIDER_ID}:name`,
      message: '服务商名称不能为空'
    })
  })

  it('reports a duplicate capture rule with its one-based index', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      selectionCapture: {
        defaultStrategy: 'selection-hook',
        applications: [
          { application: 'reader.exe', strategy: 'clipboard' },
          { application: 'Reader.exe', strategy: 'auto' }
        ]
      }
    })

    expect(result).toEqual({
      valid: false,
      field: 'captureRule:1',
      message: '第 2 条程序规则与第 1 条重复'
    })
  })

  it('reports models without an ID against the provider model field', () => {
    const result = buildSettingsUpdate({
      ...DEFAULT_PUBLIC_SETTINGS,
      providers: DEFAULT_PUBLIC_SETTINGS.providers.map((provider) => ({
        ...provider,
        models: [{ id: '  ', name: '空 ID', thinkingLevels: [] }]
      }))
    })

    expect(result).toEqual({
      valid: false,
      field: `provider:${DEFAULT_PROVIDER_ID}:models`,
      message: expect.stringContaining('模型 ID 为空')
    })
  })

  it('replaces a raw Zod English issue with a generic Chinese message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const result = buildSettingsUpdate({
        ...DEFAULT_PUBLIC_SETTINGS,
        appearance: { theme: 'not-a-theme' as never }
      })

      expect(result).toEqual({
        valid: false,
        field: undefined,
        message: '设置内容不符合保存要求，请检查标出的字段'
      })
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('maps Zod issue paths back to focusable field keys', () => {
    expect(fieldForIssuePath(['translate'], [], [])).toBe('translation')
    expect(fieldForIssuePath(['filter', 'applications', 0], [], [])).toBe('filter')
    expect(
      fieldForIssuePath(
        ['selectionCapture', 'applications', 2, 'application'],
        [],
        []
      )
    ).toBe('captureRule:2')
    expect(fieldForIssuePath(['providers', 0, 'name'], [{ id: 'p1' }], [])).toBe(
      'provider:p1:name'
    )
    expect(fieldForIssuePath(['providers', 0, 'models'], [{ id: 'p1' }], [])).toBe(
      'provider:p1:models'
    )
    expect(fieldForIssuePath(['actions', 1], [], [{ id: 'a1' }, { id: 'a2' }])).toBe(
      'action:a2'
    )
  })
})
