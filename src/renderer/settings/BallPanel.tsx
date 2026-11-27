import { useCallback, useEffect, useState, type JSX } from 'react'
import { LocateFixed, RefreshCw } from 'lucide-react'

import { BALL_SIZE_OPTIONS, type BallSettings, type BallSettingsUpdate } from '../../shared'
import { getErrorMessage } from '../lib/errors'

interface AskActionOption {
  id: string
  name: string
  enabled: boolean
}

interface BallPanelProps {
  /** Ask actions from the saved settings, for the "which action" picker. */
  askActions: AskActionOption[]
  /** Jumps to 工具栏动作, where the prompt, model and thinking level live. */
  onConfigureActions: () => void
}

/**
 * Floating orb settings.
 *
 * Every control applies immediately: the point of the size buttons is watching
 * the orb change, and there is no draft to review. Everything that shapes the
 * answer (prompt, provider, model, thinking level) belongs to an Ask action,
 * so this page points at the action editor instead of duplicating it.
 */
export function BallPanel({ askActions, onConfigureActions }: BallPanelProps): JSX.Element {
  const [settings, setSettings] = useState<BallSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setError('')
    if (!window.textLens.getBallSettings) {
      setError('当前版本不支持悬浮球设置')
      return
    }
    try {
      setSettings(await window.textLens.getBallSettings())
    } catch (loadError) {
      setError(getErrorMessage(loadError, '无法读取悬浮球设置'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const apply = useCallback(async (update: BallSettingsUpdate): Promise<void> => {
    if (!window.textLens.updateBallSettings) return
    setBusy(true)
    setError('')
    try {
      setSettings(await window.textLens.updateBallSettings(update))
    } catch (updateError) {
      setError(getErrorMessage(updateError, '无法保存悬浮球设置'))
      // Re-read so the controls show what the backend actually holds.
      await load()
    } finally {
      setBusy(false)
    }
  }, [load])

  const resetPosition = useCallback(async (): Promise<void> => {
    if (!window.textLens.resetBallPosition) return
    setBusy(true)
    setError('')
    try {
      await window.textLens.resetBallPosition()
    } catch (resetError) {
      setError(getErrorMessage(resetError, '无法重置悬浮球位置'))
    } finally {
      setBusy(false)
    }
  }, [])

  if (!settings) {
    return (
      <div className="settings-card settings-card--rows">
        <div className="setting-row">
          <div>
            <strong>正在读取悬浮球设置…</strong>
            <p>读取失败时可以重试。</p>
          </div>
          <button className="button" type="button" onClick={() => void load()}>
            <RefreshCw size={15} />
            重试
          </button>
        </div>
        {error && (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
          </div>
        )}
      </div>
    )
  }

  const selectedAction = settings.askActionId ?? ''
  const selectedActionMissing =
    settings.askActionId !== null && !askActions.some((action) => action.id === settings.askActionId)

  return (
    <>
      {error && (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="settings-card settings-card--rows">
        <div className="setting-row">
          <div>
            <strong>显示悬浮球</strong>
            <p>屏幕角落的圆形按钮，点一下直接打开问AI；托盘菜单里也能开关。</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              aria-label="显示悬浮球"
              checked={settings.visible}
              disabled={busy}
              onChange={(event) => void apply({ visible: event.target.checked })}
            />
            <span aria-hidden="true" />
          </label>
        </div>

        <div className="setting-row setting-row--stackable">
          <div>
            <strong>大小</strong>
            <p>调整后立即生效，也会同步到托盘菜单。也可以直接右键悬浮球循环切换。</p>
          </div>
          <div className="segmented-control ball-size-control" role="group" aria-label="悬浮球大小">
            {BALL_SIZE_OPTIONS.map((option) => {
              const selected = Math.abs(settings.size - option.value) < 0.5
              return (
                <button
                  key={option.value}
                  type="button"
                  className={selected ? 'is-selected' : ''}
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => void apply({ size: option.value })}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="setting-row">
          <div>
            <strong>全屏时自动隐藏</strong>
            <p>前台是全屏视频、游戏或演示时收起悬浮球，退出全屏后自动回来。</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              aria-label="全屏时自动隐藏"
              checked={settings.hideInFullscreen}
              disabled={busy}
              onChange={(event) => void apply({ hideInFullscreen: event.target.checked })}
            />
            <span aria-hidden="true" />
          </label>
        </div>

        <div className="setting-row">
          <div>
            <strong>位置</strong>
            <p>拖动悬浮球可以放到任意角落；这里可以把它放回屏幕左下角。</p>
          </div>
          <button className="button" type="button" disabled={busy} onClick={() => void resetPosition()}>
            <LocateFixed size={15} />
            回到左下角
          </button>
        </div>

        <div className="setting-row setting-row--stackable setting-row--ball-action">
          <div>
            <strong>问AI 动作用于</strong>
            <p>
              悬浮球打开的会话使用这个动作的提示词、服务商、模型和思考程度；
              这些都在「工具栏动作」里编辑，和工具栏上的「问AI」是同一套配置。
            </p>
          </div>
          <div className="ball-action-picker">
            <select
              className="control"
              aria-label="悬浮球使用的问AI动作"
              value={selectedAction}
              disabled={busy || askActions.length === 0}
              onChange={(event) => void apply({ askActionId: event.target.value })}
            >
              <option value="">自动（第一个启用的问AI动作）</option>
              {askActions.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.name}
                  {action.enabled ? '' : '（已停用）'}
                </option>
              ))}
              {selectedActionMissing && (
                <option value={selectedAction}>{settings.askActionId}（已不存在）</option>
              )}
            </select>
            <button className="button" type="button" onClick={onConfigureActions}>
              配置动作
            </button>
          </div>
        </div>
        {askActions.length === 0 && (
          <p className="ball-panel-hint" role="status">
            还没有问AI动作：先在「工具栏动作」里启用或新建一个，悬浮球才能开问。
          </p>
        )}
      </div>
    </>
  )
}
