import { useCallback, useEffect, useState, type JSX } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'

import type { RequestLogEntry } from '../../shared/schemas'
import { Dialog } from '../components/Dialog'
import { getErrorMessage } from '../lib/errors'

const STATUS_LABELS: Record<RequestLogEntry['status'], string> = {
  completed: '成功',
  failed: '失败',
  cancelled: '已取消'
}

/** Stored timestamps are UTC; show the local clock, like the result history. */
function localTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${parsed.getMonth() + 1}-${pad(parsed.getDate())} ${
    pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

/**
 * Audit trail for the provider calls this app makes with the user's own key.
 * Metadata only: no prompt text and no answer text ever appear here.
 */
export function RequestLogPanel(): JSX.Element {
  const [entries, setEntries] = useState<RequestLogEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!window.textLens.listRequestLog) {
      setStatus('error')
      setError('当前版本不支持请求日志')
      return
    }
    setStatus('loading')
    setError('')
    try {
      setEntries(await window.textLens.listRequestLog(200))
      setStatus('ready')
    } catch (loadError) {
      setStatus('error')
      setError(getErrorMessage(loadError, '无法读取请求日志'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const clear = useCallback(async (): Promise<void> => {
    if (!window.textLens.clearRequestLog) return
    setClearing(true)
    try {
      await window.textLens.clearRequestLog()
      setEntries([])
      setClearOpen(false)
    } catch (clearError) {
      setError(getErrorMessage(clearError, '无法清空请求日志'))
    } finally {
      setClearing(false)
    }
  }, [])

  return (
    <>
      <div className="settings-tip" role="note">
        <span className="settings-tip__label">只记元数据</span>
        <p className="request-log-note">
          记录每次请求的时间、动作、模型、字数和 token，不保存选中文字或回答正文。日志只存在本机。
        </p>
      </div>
      <div className="history-toolbar request-log-toolbar">
        <button className="button" type="button" disabled={status === 'loading'} onClick={() => void load()}>
          <RefreshCw size={15} className={status === 'loading' ? 'settings-spin' : undefined} />
          刷新
        </button>
        <button
          className="button button--danger"
          type="button"
          disabled={entries.length === 0 || clearing}
          onClick={() => setClearOpen(true)}
        >
          <Trash2 size={15} />
          清空全部
        </button>
      </div>

      {error && (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {status === 'ready' && entries.length === 0 && (
        <p className="request-log-empty">还没有请求记录。完成一次 AI 动作后会出现在这里。</p>
      )}

      {entries.length > 0 && (
        <ul className="request-log-list">
          {entries.map((entry, index) => (
            <li className="request-log-row" key={`${entry.createdAt}-${index}`}>
              <span className="request-log-row__time">{localTimestamp(entry.createdAt)}</span>
              <span className="request-log-row__action">{entry.actionName || '—'}</span>
              <span className="request-log-row__model" title={entry.endpointHost || undefined}>
                {entry.modelId || '—'}
              </span>
              <span
                className={`request-log-row__status ${entry.status === 'failed' ? 'request-log-row__status--failed' : ''}`}
                title={entry.errorCode ?? undefined}
              >
                {STATUS_LABELS[entry.status]}
              </span>
              <span className="request-log-row__numbers">
                {formatCount(entry.characterCount)} 字
                {entry.totalTokens !== undefined ? ` · ${formatCount(entry.totalTokens)} tokens` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {clearOpen && (
        <Dialog className="provider-delete-dialog" label="清空请求日志？" onClose={() => setClearOpen(false)}>
          <header className="dialog-header">
            <div>
              <h2>清空请求日志？</h2>
              <p>只删除本机的请求记录；已保存的结果历史不受影响。</p>
            </div>
          </header>
          <footer className="dialog-actions provider-delete-dialog__actions">
            <button className="button" type="button" data-dialog-initial-focus onClick={() => setClearOpen(false)}>
              取消
            </button>
            <button className="button button--danger" type="button" disabled={clearing} onClick={() => void clear()}>
              清空
            </button>
          </footer>
        </Dialog>
      )}
    </>
  )
}
