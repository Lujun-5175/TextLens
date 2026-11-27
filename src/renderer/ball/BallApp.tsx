import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { MessageCircleQuestion } from 'lucide-react'

import { getErrorMessage } from '../lib/errors'

/**
 * Pointer travel that turns a press into a window drag, in CSS pixels measured
 * inside the orb. Client coordinates are used on purpose: they cannot be stale
 * the way `screenX/screenY` can after the cursor jumps, and a phantom few-pixel
 * "move" would otherwise turn every click into a drag that relocates the orb.
 */
const DRAG_THRESHOLD_PX = 6
/**
 * A press must also last this long before it can become a drag. A real drag is
 * always slower than this; an ordinary click is not.
 */
const DRAG_HOLD_MS = 100
/** How long the orb must sit still before its new screen position is saved. */
const POSITION_SAVE_DELAY_MS = 400
/** How long the failure ring stays after a rejected open, in milliseconds. */
const FAILURE_FEEDBACK_MS = 1_200

type DragState = { x: number; y: number; startedAt: number; dragging: boolean }

/**
 * The floating orb.
 *
 * One click opens an empty Ask window: no selection, no clipboard read. Failures
 * are configuration problems ("pick a model", "save an API key"), so they open
 * Settings with the native message instead of drawing an unreachable tooltip in
 * a 56px window.
 */
export function BallApp() {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const drag = useRef<DragState | null>(null)
  const failureTimer = useRef<number | null>(null)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let unlisten: (() => void) | undefined
    let saveTimer: number | undefined
    let disposed = false
    void appWindow
      .onMoved(({ payload }) => {
        // `startDragging` moves the window continuously; persist once the user
        // lets go instead of writing ball.json on every frame.
        if (saveTimer !== undefined) window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          void window.textLens.moveBall?.(payload.x, payload.y).catch(() => {
            // Remembering the position is a convenience; a failed write must not
            // surface as an error for a purely cosmetic action.
          })
        }, POSITION_SAVE_DELAY_MS)
      })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        // No native window handle (preview browser): the orb still clicks.
      })
    return () => {
      disposed = true
      unlisten?.()
      if (saveTimer !== undefined) window.clearTimeout(saveTimer)
    }
  }, [])

  useEffect(
    () => () => {
      if (failureTimer.current !== null) window.clearTimeout(failureTimer.current)
    },
    []
  )

  const ask = useCallback(async () => {
    if (drag.current?.dragging) return
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      const result = await window.textLens.openAskFromBall?.()
      if (result && !result.accepted) {
        setFailed(true)
        if (failureTimer.current !== null) window.clearTimeout(failureTimer.current)
        failureTimer.current = window.setTimeout(() => setFailed(false), FAILURE_FEEDBACK_MS)
        // Every rejection here is actionable (disabled action, missing model or
        // key), so hand it to Settings where it can actually be fixed.
        await window.textLens
          .openSettings?.({ notice: result.message })
          .catch(() => undefined)
      }
    } catch (error) {
      setFailed(true)
      if (failureTimer.current !== null) window.clearTimeout(failureTimer.current)
      failureTimer.current = window.setTimeout(() => setFailed(false), FAILURE_FEEDBACK_MS)
      console.error('[TextLens][ball]', getErrorMessage(error, '无法打开问AI窗口'))
    } finally {
      setBusy(false)
    }
  }, [busy])

  return (
    <div className="ball-root">
      <button
        className={`ball-button${failed ? ' ball-button--failed' : ''}`}
        type="button"
        aria-label="打开问AI"
        title="问AI"
        disabled={busy}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture?.(event.pointerId)
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            startedAt: performance.now(),
            dragging: false
          }
        }}
        onPointerMove={(event) => {
          const state = drag.current
          if (!state || state.dragging) return
          // A move delivered without a held button is stale input, not a drag.
          if (event.buttons === 0) {
            drag.current = null
            return
          }
          const dx = event.clientX - state.x
          const dy = event.clientY - state.y
          if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
          if (performance.now() - state.startedAt < DRAG_HOLD_MS) return
          state.dragging = true
          void getCurrentWindow()
            .startDragging()
            .catch(() => {
              // A non-activating window on a locked-down desktop may refuse the
              // native drag loop; the click still works.
            })
        }}
        onPointerUp={() => {
          // `startDragging` takes over the pointer, so this only runs for a
          // real click/tap. The flag is cleared on the next press.
        }}
        onContextMenu={(event) => {
          // Right-click cycles the size: the tray submenu is the documented
          // path, this is the shortcut for people who try right-clicking.
          event.preventDefault()
          void Promise.resolve(window.textLens.cycleBallSize?.()).catch(() => undefined)
        }}
        onClick={() => {
          if (drag.current?.dragging) {
            drag.current = null
            return
          }
          drag.current = null
          void ask()
        }}
      >
        {busy && <span className="ball-ring" aria-hidden="true" />}
        <MessageCircleQuestion className="ball-icon" aria-hidden="true" />
      </button>
    </div>
  )
}
