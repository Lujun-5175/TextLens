import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import {
  DEFAULT_PUBLIC_SETTINGS,
  type ResultHistoryEntry,
  type WindowTextLensApi
} from '../../shared'
import { SettingsApp } from './SettingsApp'

const PRIVACY_NOTE = '结果只保存在本机，不会上传；可在下方随时删除或清空。'

function historyEntry(overrides: Partial<ResultHistoryEntry> = {}): ResultHistoryEntry {
  return {
    id: 'entry-2',
    createdAt: '2026-11-26T08:30:00Z',
    actionId: 'translate',
    actionName: '翻译',
    providerId: 'provider-1',
    modelId: 'gpt-4o',
    sourceText: 'alpha source',
    content: '第一行结论\n第二行细节',
    usage: { totalTokens: 42 },
    ...overrides
  }
}

interface HistoryBridge {
  api: WindowTextLensApi
  listResultHistory: ReturnType<typeof vi.fn>
  deleteResultHistoryEntry: ReturnType<typeof vi.fn>
  copyResultHistoryEntry: ReturnType<typeof vi.fn>
  clearResultHistory: ReturnType<typeof vi.fn>
  copyText: ReturnType<typeof vi.fn>
}

function installHistoryBridge(entries: ResultHistoryEntry[] = []): HistoryBridge {
  const listResultHistory = vi.fn(async () => entries)
  const deleteResultHistoryEntry = vi.fn(async () => true)
  const copyResultHistoryEntry = vi.fn(async () => undefined)
  const clearResultHistory = vi.fn(async () => undefined)
  const copyText = vi.fn(async () => undefined)
  const api = {
    getSettings: vi.fn(async () => DEFAULT_PUBLIC_SETTINGS),
    updateSettings: vi.fn(async () => DEFAULT_PUBLIC_SETTINGS),
    getAccessibilityStatus: vi.fn(async () => ({
      platform: 'windows',
      trusted: true,
      canRequest: false,
      available: true,
      diagnostics: {}
    })),
    requestAccessibility: vi.fn(),
    onSettingsChanged: vi.fn(() => () => undefined),
    onSettingsCloseRequested: vi.fn(() => () => undefined),
    listResultHistory,
    deleteResultHistoryEntry,
    copyResultHistoryEntry,
    clearResultHistory,
    copyText
  } as unknown as WindowTextLensApi
  window.textLens = api
  return {
    api,
    listResultHistory,
    deleteResultHistoryEntry,
    copyResultHistoryEntry,
    clearResultHistory,
    copyText
  }
}

async function openHistorySection(): Promise<void> {
  await screen.findByRole('navigation', { name: '设置分区' })
  fireEvent.click(screen.getByRole('button', { name: '历史记录' }))
  await screen.findByRole('heading', { name: '历史记录' })
}

describe('SettingsApp result history', () => {
  it('shows the privacy note and empty state without any stored results', async () => {
    installHistoryBridge([])
    render(<SettingsApp />)

    await openHistorySection()

    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument()
    expect(await screen.findByText('还没有记录')).toBeInTheDocument()
    expect(screen.getByText('完成一次 AI 动作后会出现在这里。')).toBeInTheDocument()
  })

  it('lists entries newest-first with time, action, model and a first-line summary', async () => {
    installHistoryBridge([
      historyEntry(),
      historyEntry({
        id: 'entry-1',
        createdAt: '2026-11-25T09:00:00Z',
        actionId: 'summary',
        actionName: '总结',
        modelId: 'claude-3',
        sourceText: 'beta source',
        content: '总结内容 beta',
        usage: undefined
      })
    ])
    render(<SettingsApp />)

    await openHistorySection()

    expect(await screen.findByText('翻译')).toBeInTheDocument()
    // Rendered in the machine's local zone, so assert the shape: the bug this
    // guards against was showing the stored UTC value as if it were local.
    expect(screen.getAllByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u)).toHaveLength(2)
    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    expect(screen.getByText('第一行结论')).toBeInTheDocument()
    expect(screen.getByText('总结')).toBeInTheDocument()
    expect(screen.getByText('总结内容 beta')).toBeInTheDocument()
  })

  it('filters by action name, content and source text', async () => {
    installHistoryBridge([
      historyEntry(),
      historyEntry({
        id: 'entry-1',
        actionId: 'summary',
        actionName: '总结',
        modelId: 'claude-3',
        sourceText: 'beta source',
        content: '总结内容 beta'
      })
    ])
    render(<SettingsApp />)
    await openHistorySection()
    await screen.findByText('翻译')

    const search = screen.getByRole('searchbox', { name: '搜索历史记录' })

    fireEvent.change(search, { target: { value: '总结' } })
    expect(screen.getByText('总结')).toBeInTheDocument()
    expect(screen.queryByText('第一行结论')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'alpha source' } })
    expect(screen.getByText('第一行结论')).toBeInTheDocument()
    expect(screen.queryByText('总结')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: '第二行' } })
    expect(screen.getByText('第一行结论')).toBeInTheDocument()
    expect(screen.queryByText('总结')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'zzz-no-match' } })
    expect(screen.getByText('没有匹配的记录')).toBeInTheDocument()
  })

  it('expands and collapses the full answer', async () => {
    installHistoryBridge([historyEntry()])
    render(<SettingsApp />)
    await openHistorySection()
    await screen.findByText('第一行结论')

    expect(screen.queryByText(/第二行细节/)).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /第一行结论/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/第二行细节/)).toBeInTheDocument()
    expect(screen.getByText('原文')).toBeInTheDocument()
    expect(screen.getByText('alpha source')).toBeInTheDocument()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/第二行细节/)).not.toBeInTheDocument()
  })

  it('copies the full stored answer', async () => {
    const bridge = installHistoryBridge([historyEntry()])
    render(<SettingsApp />)
    await openHistorySection()
    await screen.findByText('第一行结论')

    fireEvent.click(screen.getByRole('button', { name: '复制记录：翻译' }))

    await waitFor(() =>
      expect(bridge.copyResultHistoryEntry).toHaveBeenCalledWith('entry-2')
    )
    // The settings window never falls back to the result-window-only command.
    expect(bridge.copyText).not.toHaveBeenCalled()
  })

  it('deletes a single entry through the native command', async () => {
    const bridge = installHistoryBridge([historyEntry()])
    render(<SettingsApp />)
    await openHistorySection()
    await screen.findByText('第一行结论')

    fireEvent.click(screen.getByRole('button', { name: '删除记录：翻译' }))

    await waitFor(() =>
      expect(bridge.deleteResultHistoryEntry).toHaveBeenCalledWith('entry-2')
    )
    expect(await screen.findByText('还没有记录')).toBeInTheDocument()
    expect(screen.queryByText('第一行结论')).not.toBeInTheDocument()
  })

  it('requires confirmation before clearing every entry', async () => {
    const bridge = installHistoryBridge([historyEntry()])
    render(<SettingsApp />)
    await openHistorySection()
    await screen.findByText('第一行结论')

    fireEvent.click(screen.getByRole('button', { name: '清空全部' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('清空全部历史记录？')).toBeInTheDocument()
    // Cancelling keeps the list and never calls the command.
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(bridge.clearResultHistory).not.toHaveBeenCalled()
    expect(screen.getByText('第一行结论')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '清空全部' }))
    const confirmDialog = await screen.findByRole('dialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '清空全部' }))

    await waitFor(() => expect(bridge.clearResultHistory).toHaveBeenCalledOnce())
    expect(await screen.findByText('还没有记录')).toBeInTheDocument()
    expect(screen.queryByText('第一行结论')).not.toBeInTheDocument()
  })

  it('surfaces a read failure instead of an empty list', async () => {
    const bridge = installHistoryBridge([])
    bridge.listResultHistory.mockRejectedValue(new Error('results.jsonl 被占用'))
    render(<SettingsApp />)

    await openHistorySection()

    expect(await screen.findByRole('alert')).toHaveTextContent('results.jsonl 被占用')
    expect(screen.queryByText('还没有记录')).not.toBeInTheDocument()
  })
})
