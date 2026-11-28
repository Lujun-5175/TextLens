import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { BallSettings, WindowTextLensApi } from '../../shared'
import { BallMenuApp } from './BallMenuApp'

const INITIAL: BallSettings = {
  visible: true,
  size: 56,
  hideInFullscreen: true,
  askActionId: null
}

function installBridge() {
  const getBallSettings = vi.fn(async () => INITIAL)
  const updateBallSettings = vi.fn(async (update: Partial<BallSettings>) => ({
    ...INITIAL,
    ...update
  }))
  const resetBallPosition = vi.fn(async () => undefined)
  const closeBallMenu = vi.fn(async () => undefined)
  const showBallMenu = vi.fn(async () => undefined)
  const openSettings = vi.fn(async () => undefined)
  window.textLens = {
    getBallSettings,
    updateBallSettings,
    resetBallPosition,
    closeBallMenu,
    showBallMenu,
    openSettings
  } as unknown as WindowTextLensApi
  return { getBallSettings, updateBallSettings, resetBallPosition, closeBallMenu, showBallMenu, openSettings }
}

describe('BallMenuApp', () => {
  it('applies a size the moment it is picked', async () => {
    const { updateBallSettings } = installBridge()
    render(<BallMenuApp />)

    const large = await screen.findByRole('button', { name: '大' })
    fireEvent.click(large)

    await waitFor(() => expect(updateBallSettings).toHaveBeenCalledWith({ size: 72 }))
    await waitFor(() => expect(large).toHaveAttribute('aria-pressed', 'true'))
  })

  it('closes the panel after hiding the orb', async () => {
    const { updateBallSettings, closeBallMenu } = installBridge()
    render(<BallMenuApp />)

    fireEvent.click(await screen.findByRole('checkbox', { name: '显示悬浮球' }))

    await waitFor(() => expect(updateBallSettings).toHaveBeenCalledWith({ visible: false }))
    await waitFor(() => expect(closeBallMenu).toHaveBeenCalledTimes(1))
  })

  it('resets the position and closes', async () => {
    const { resetBallPosition, closeBallMenu } = installBridge()
    render(<BallMenuApp />)

    fireEvent.click(await screen.findByRole('button', { name: '回到左下角' }))

    await waitFor(() => expect(resetBallPosition).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(closeBallMenu).toHaveBeenCalledTimes(1))
  })

  it('opens the full settings page on the orb section', async () => {
    const { openSettings, closeBallMenu } = installBridge()
    render(<BallMenuApp />)

    fireEvent.click(await screen.findByRole('button', { name: '更多设置' }))

    await waitFor(() =>
      expect(openSettings).toHaveBeenCalledWith({ focus: 'ball' })
    )
    expect(closeBallMenu).toHaveBeenCalled()
  })

  it('closes on Escape and on a later blur', async () => {
    vi.useFakeTimers()
    try {
      const { closeBallMenu } = installBridge()
      render(<BallMenuApp />)

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(closeBallMenu).toHaveBeenCalledTimes(1)

      // After the settling window a blur means the user clicked elsewhere.
      await vi.advanceTimersByTimeAsync(700)
      window.dispatchEvent(new Event('blur'))
      expect(closeBallMenu).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores the creation-time focus bounce', async () => {
    vi.useFakeTimers()
    try {
      const { closeBallMenu } = installBridge()
      render(<BallMenuApp />)

      // WebView2 focuses the new window and hands activation back; this blur
      // must not close the panel.
      window.dispatchEvent(new Event('blur'))
      await vi.advanceTimersByTimeAsync(300)
      expect(closeBallMenu).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
