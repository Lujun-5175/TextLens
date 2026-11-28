import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { LocateFixed, Settings2, X } from 'lucide-react'

import { BALL_SIZE_OPTIONS, type BallSettings, type BallSettingsUpdate } from '../../shared'
import { getErrorMessage } from '../lib/errors'

/**
 * The orb's right-click panel.
 *
 * It is a popover, not a settings page: every control applies the moment it is
 * clicked, and hiding the orb closes the panel with it. Anything that shapes
 * the answer (prompt, provider, model) stays in the full settings window, which
 * the last row opens on the orb section.
 */
export function BallMenuApp(): JSX.Element {
  const [settings, setSettings] = useState<BallSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // See the blur listener below: closing is armed only after the window has
  // settled, so creation-time focus churn cannot dismiss the panel.
  const armed = useRef(false)

  const close = useCallback((): void => {
    void Promise.resolve(window.textLens.closeBallMenu?.()).catch(() => undefined)
  }, [])

  useEffect(() => {
    // The native side keeps the window hidden until this point: a transparent
    // window shown before WebView2 finished constructing renders blank.
    void Promise.resolve(window.textLens.showBallMenu?.()).catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = await window.textLens.getBallSettings?.()
        if (!cancelled && loaded) setSettings(loaded)
      } catch (loadError) {
        if (!cancelled) setError(getErrorMessage(loadError, '无法读取悬浮球设置'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    // A popover that stays open over another application reads as stuck: it
    // closes as soon as the user clicks anywhere else. The first few hundred
    // milliseconds are exempt: WebView2 hands the new window focus, then takes
    // it back while the user's own window regains activation, and closing on
    // that bounce made the panel flash and disappear.
    const onBlur = (): void => {
      if (armed.current) close()
    }
    const timer = window.setTimeout(() => {
      armed.current = true
    }, 600)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [close])

  const apply = useCallback(async (update: BallSettingsUpdate): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const next = await window.textLens.updateBallSettings?.(update)
      if (next) setSettings(next)
      // The orb disappears when it is hidden, and a panel anchored to nothing
      // must not stay behind.
      if (update.visible === false) close()
    } catch (updateError) {
      setError(getErrorMessage(updateError, '无法保存悬浮球设置'))
    } finally {
      setBusy(false)
    }
  }, [close])

  const resetPosition = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.textLens.resetBallPosition?.()
      close()
    } catch (resetError) {
      setError(getErrorMessage(resetError, '无法重置悬浮球位置'))
    } finally {
      setBusy(false)
    }
  }, [close])

  const openFullSettings = useCallback((): void => {
    void window.textLens.openSettings?.({ focus: 'ball' }).catch(() => undefined)
    close()
  }, [close])

  const size = settings?.size ?? 56

  return (
    <div className="ball-menu" role="dialog" aria-label="悬浮球设置">
      <header className="ball-menu__header">
        <span>悬浮球</span>
        <button className="ball-menu__close" type="button" aria-label="关闭悬浮球菜单" onClick={close}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="ball-menu__group">
        <span className="ball-menu__label">大小</span>
        <div className="ball-menu__sizes" role="group" aria-label="悬浮球大小">
          {BALL_SIZE_OPTIONS.map((option) => {
            const selected = Math.abs(size - option.value) < 0.5
            return (
              <button
                key={option.value}
                type="button"
                className={selected ? 'is-selected' : ''}
                aria-pressed={selected}
                disabled={busy || !settings}
                onClick={() => void apply({ size: option.value })}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      <label className="ball-menu__row">
        <span>显示悬浮球</span>
        <span className="ball-menu__switch">
          <input
            type="checkbox"
            aria-label="显示悬浮球"
            checked={settings?.visible ?? true}
            disabled={busy || !settings}
            onChange={(event) => void apply({ visible: event.target.checked })}
          />
          <span aria-hidden="true" />
        </span>
      </label>

      <label className="ball-menu__row">
        <span>全屏时自动隐藏</span>
        <span className="ball-menu__switch">
          <input
            type="checkbox"
            aria-label="全屏时自动隐藏"
            checked={settings?.hideInFullscreen ?? true}
            disabled={busy || !settings}
            onChange={(event) => void apply({ hideInFullscreen: event.target.checked })}
          />
          <span aria-hidden="true" />
        </span>
      </label>

      {error && (
        <p className="ball-menu__error" role="alert">
          {error}
        </p>
      )}

      <div className="ball-menu__actions">
        <button className="ball-menu__button" type="button" disabled={busy || !settings} onClick={() => void resetPosition()}>
          <LocateFixed size={14} aria-hidden="true" />
          回到左下角
        </button>
        <button className="ball-menu__button" type="button" onClick={openFullSettings}>
          <Settings2 size={14} aria-hidden="true" />
          更多设置
        </button>
      </div>
    </div>
  )
}
