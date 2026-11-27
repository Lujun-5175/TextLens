import { fireEvent, render, screen } from '@testing-library/react'

import { DEFAULT_PUBLIC_SETTINGS, type WindowTextLensApi } from '../../shared'
import { SettingsApp } from './SettingsApp'

function installBridge(): void {
  window.textLens = {
    getSettings: vi.fn(async () => DEFAULT_PUBLIC_SETTINGS),
    updateSettings: vi.fn(async () => DEFAULT_PUBLIC_SETTINGS),
    getAccessibilityStatus: vi.fn(async () => ({
      platform: 'windows',
      trusted: true,
      canRequest: false
    })),
    requestAccessibility: vi.fn(),
    onSettingsChanged: vi.fn(() => () => undefined)
  } as unknown as WindowTextLensApi
}

async function searchFor(value: string): Promise<HTMLElement> {
  await screen.findByRole('navigation', { name: '设置分区' })
  const input = screen.getByRole('searchbox', { name: '搜索设置' })
  fireEvent.change(input, { target: { value } })
  return input
}

describe('SettingsApp section search', () => {
  it('filters the nav by a keyword the label does not contain', async () => {
    installBridge()
    render(<SettingsApp />)

    await searchFor('api key')

    expect(screen.getByRole('button', { name: 'AI 服务商' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '外观' })).not.toBeInTheDocument()
  })

  it('jumps to the first match on Enter and clears on Escape', async () => {
    installBridge()
    render(<SettingsApp />)

    const input = await searchFor('主题')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: '外观' })).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(screen.getByRole('button', { name: '历史记录' })).toBeInTheDocument()
  })

  it('keeps the current section visible when nothing matches instead of crashing', async () => {
    installBridge()
    render(<SettingsApp />)

    await searchFor('zzz-no-such-setting')

    expect(screen.getByText('没有匹配的设置页')).toBeInTheDocument()
    // The pane must not be derived from an empty match list: it stays on the
    // section the user was looking at.
    expect(screen.getByRole('heading', { name: '常规' })).toBeInTheDocument()
  })
})
