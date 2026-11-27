import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { RequestLogEntry, WindowTextLensApi } from '../../shared'
import { RequestLogPanel } from './RequestLogPanel'

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    createdAt: '2026-11-26T06:03:00Z',
    actionName: '翻译',
    providerName: 'DeepSeek',
    modelId: 'deepseek-chat',
    endpointHost: 'api.deepseek.com',
    characterCount: 1200,
    status: 'completed',
    totalTokens: 420,
    ...overrides
  }
}

function installBridge(entries: RequestLogEntry[]) {
  const listRequestLog = vi.fn(async () => entries)
  const clearRequestLog = vi.fn(async () => undefined)
  window.textLens = { listRequestLog, clearRequestLog } as unknown as WindowTextLensApi
  return { listRequestLog, clearRequestLog }
}

describe('RequestLogPanel', () => {
  it('shows the local timestamp with its year and the token counts', async () => {
    installBridge([entry()])
    render(<RequestLogPanel />)

    // The stored value is UTC; the panel renders the machine's local zone.
    const expected = new Date('2026-11-26T06:03:00Z')
    const pad = (part: number): string => String(part).padStart(2, '0')
    const stamp = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())} ` +
      `${pad(expected.getHours())}:${pad(expected.getMinutes())}`

    expect(await screen.findByText(stamp)).toBeInTheDocument()
    expect(screen.getByText('1,200')).toBeInTheDocument()
    expect(screen.getByText('420')).toBeInTheDocument()
  })

  it('narrows the table by status and by action, then clears both', async () => {
    installBridge([
      entry(),
      entry({ actionName: '总结', status: 'failed', errorCode: 'timeout', modelId: 'deepseek-reasoner' })
    ])
    render(<RequestLogPanel />)

    // "总结" is also an <option> in the action filter, so the row checks are
    // scoped to the table itself.
    const table = await screen.findByRole('table')
    expect(within(table).getByText('总结')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('共 2 条')

    fireEvent.change(screen.getByRole('combobox', { name: '按状态筛选' }), {
      target: { value: 'failed' }
    })
    expect(within(table).queryByText('翻译')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 / 2 条')

    fireEvent.change(screen.getByRole('combobox', { name: '按动作筛选' }), {
      target: { value: '翻译' }
    })
    // Status "failed" plus action "翻译" describes no row at all.
    expect(screen.getByText('没有符合条件的记录')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(within(screen.getByRole('table')).getByText('翻译')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('共 2 条')
  })

  it('explains an empty log instead of rendering a bare header row', async () => {
    installBridge([])
    render(<RequestLogPanel />)

    expect(await screen.findByText('还没有请求记录')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('clears the log through the native command after confirmation', async () => {
    const bridge = installBridge([entry()])
    render(<RequestLogPanel />)

    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: '清空全部' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '清空' }))

    await waitFor(() => expect(bridge.clearRequestLog).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('还没有请求记录')).toBeInTheDocument()
  })
})
