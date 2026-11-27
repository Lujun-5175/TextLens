import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BallSettings, WindowTextLensApi } from '../../shared'
import { BallPanel } from './BallPanel'

const INITIAL: BallSettings = {
  visible: true,
  size: 56,
  hideInFullscreen: true,
  askActionId: null
}

function installBridge(initial: BallSettings = INITIAL) {
  const getBallSettings = vi.fn(async () => initial)
  const updateBallSettings = vi.fn(async (update: Partial<BallSettings>) => ({
    ...initial,
    ...update
  }))
  const resetBallPosition = vi.fn(async () => undefined)
  window.textLens = {
    getBallSettings,
    updateBallSettings,
    resetBallPosition
  } as unknown as WindowTextLensApi
  return { getBallSettings, updateBallSettings, resetBallPosition }
}

const ASK_ACTIONS = [
  { id: 'ask-ai', name: '问AI', enabled: true },
  { id: 'ask-deep', name: '深问', enabled: true }
]

describe('BallPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('applies the size immediately instead of waiting for a save', async () => {
    const { updateBallSettings } = installBridge()
    render(<BallPanel askActions={ASK_ACTIONS} onConfigureActions={() => undefined} />)

    const large = await screen.findByRole('button', { name: '大' })
    fireEvent.click(large)

    await waitFor(() => expect(updateBallSettings).toHaveBeenCalledWith({ size: 72 }))
    await waitFor(() => expect(large).toHaveAttribute('aria-pressed', 'true'))
  })

  it('toggles visibility and the fullscreen rule', async () => {
    const { updateBallSettings } = installBridge()
    render(<BallPanel askActions={ASK_ACTIONS} onConfigureActions={() => undefined} />)

    fireEvent.click(await screen.findByRole('checkbox', { name: '显示悬浮球' }))
    await waitFor(() => expect(updateBallSettings).toHaveBeenCalledWith({ visible: false }))

    fireEvent.click(screen.getByRole('checkbox', { name: '全屏时自动隐藏' }))
    await waitFor(() =>
      expect(updateBallSettings).toHaveBeenCalledWith({ hideInFullscreen: false })
    )
  })

  it('picks the ask action and resets the orb position', async () => {
    const { updateBallSettings, resetBallPosition } = installBridge()
    render(<BallPanel askActions={ASK_ACTIONS} onConfigureActions={() => undefined} />)

    const picker = await screen.findByRole('combobox', { name: '悬浮球使用的问AI动作' })
    fireEvent.change(picker, { target: { value: 'ask-deep' } })
    await waitFor(() => expect(updateBallSettings).toHaveBeenCalledWith({ askActionId: 'ask-deep' }))

    fireEvent.click(screen.getByRole('button', { name: '回到左下角' }))
    await waitFor(() => expect(resetBallPosition).toHaveBeenCalledTimes(1))
  })

  it('points at the action editor and warns when no ask action exists', async () => {
    installBridge()
    const onConfigureActions = vi.fn()
    render(<BallPanel askActions={[]} onConfigureActions={onConfigureActions} />)

    expect(await screen.findByText(/还没有问AI动作/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '配置动作' }))
    expect(onConfigureActions).toHaveBeenCalledTimes(1)
  })
})
